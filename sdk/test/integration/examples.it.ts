// Every code example in the zenius Skill (SKILL.md, guide.md, references/)
// runs on the dev instance as its text says, through the plain CLI and
// through the sandboxed launcher (scripts/install-cli.sh --sandbox), and
// prints what the text says. Both run with the scratch HOME and ZENIUS_HOME
// test/integration/scratch-env.ts made, whose config names the dev Zen's
// working folder. Agents copy these before anything else, so each
// example has a check below, keyed by its first line: an example that's new,
// or whose first line changed, fails "has a check" until it gets one, and
// one that stops working fails its own test.
//
// Placeholders are filled in, and each replacement must still find its text:
// https://example.com is a fixture page (nothing leaves this machine),
// /absolute/path/ a scratch folder, 7 a real task space's id, and @12 and @21
// refs from the previous round's snapshot.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { guardHome } from "../../../tests/lib/scratch-home.mjs";
import { socketPath } from "../../src/instance.ts";
import { answerClaims, needs, unique, useContext, zeniusJson, type Context } from "./context.ts";
import { FIXTURE_PNG, noted } from "./fixtures.ts";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = join(SDK, "..");
const CLI = join(SDK, "bin/zenius");

type Block = { file: string; line: number; language: string; code: string; first: string };

/** Every fenced code block in the Skill's Markdown, where agents read it, a list item's indented ones included. */
function skillBlocks(): Block[] {
  const references = readdirSync(join(ROOT, "skill/zenius/references")).filter((name) => name.endsWith(".md"));
  const files = ["skill/zenius/SKILL.md", "skill/guide.md", ...references.sort().map((name) => `skill/zenius/references/${name}`)];
  return files.flatMap((file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    return [...text.matchAll(/^( *)```(\w*)\n([\s\S]*?)^\1```$/gm)].map((match) => {
      const indent = match[1]!;
      const code = match[3]!
        .split("\n")
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join("\n");
      return { file, line: text.slice(0, match.index).split("\n").length, language: match[2]!, code, first: code.split("\n")[0]! };
    });
  });
}

const BLOCKS = skillBlocks();

type Run = { code: number | null; stdout: string; stderr: string };
type Mode = "plain" | "sandboxed";

const linux = process.platform === "linux";
const SANDBOX = linux
  ? spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"]).status === 0
  : process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

const context = useContext();

/** The scratch folders, made by its real path: on macOS the temp folder is a link. */
const root = realpathSync(mkdtempSync(join(tmpdir(), "zenius-examples-")));
/** The folder every run starts in, its current folder: the sandbox may read it, never write it. */
const work = join(root, "project");
/** Where a plain run's absolute paths point. */
const files = join(root, "files");
/**
 * The working folder, the dev Zen's own (test-integration.sh): finished
 * downloads land there, and a sandboxed run's relative paths. As the config
 * names it, which is how the launcher passes it on.
 */
const working = process.env.ZENIUS_IT_WORKING_DIR ?? "";
/** A `zenius` for shell examples in the plain CLI: this checkout's, on this Node. */
const shim = join(root, "shim");
/** The sandboxed launcher's folder. */
const launcherDir = join(root, "bin");

/** Task spaces the examples name themselves: no sweep matches them. */
const NAMED = ["inspect example page", "descriptive goal name"];

before(() => {
  for (const dir of [work, files, shim]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shim, "zenius"), `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`);
  chmodSync(join(shim, "zenius"), 0o755);
  for (const dir of [files, work]) writeFileSync(join(dir, "report.pdf"), "%PDF-1.4 zenius example\n");
  if (!SANDBOX) return;
  // The scratch zenius home's config names the working folder, and the
  // install keeps it.
  const install = spawnSync("bash", [join(ROOT, "scripts/install-cli.sh"), "--sandbox"], {
    encoding: "utf8",
    env: guardHome(
      {
        ...process.env,
        ZENIUS_CLI_DIR: join(root, "cli"),
        ZENIUS_BIN_DIR: launcherDir,
        ZENIUS_SKILL_DIRS: `${join(root, "claude")} ${join(root, "agents")}`,
        // test-integration.sh built dist/ already; another build would race the suite.
        ZENIUS_INSTALL_NO_BUILD: "1",
      },
      "examples.it",
    ),
  });
  assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
  assert.ok(install.stdout.includes(`ok       the working folder: ${working}`), install.stdout);
});

after(async () => {
  try {
    await finishNamed();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function spawnRun(command: string, args: string[], options: { stdin?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: work, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      stderr += `\n[examples] killed after ${options.timeoutMs ?? 60_000} ms\n`;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** Runs scripts and shell lines as an agent does, through one CLI. */
class Runner {
  readonly mode: Mode;

  constructor(mode: Mode) {
    this.mode = mode;
  }

  get sandboxed(): boolean {
    return this.mode === "sandboxed";
  }

  #env(): NodeJS.ProcessEnv {
    // The sandbox's own temporary folder goes in the scratch folder too.
    return guardHome(
      { ...process.env, ZENIUS_INSTANCE: context.instance, ZENIUS_TIMING: "", ...(this.sandboxed ? { TMPDIR: root } : {}) },
      "examples.it",
    );
  }

  /** `zenius nodejs` with `code` on stdin. */
  script(code: string): Promise<Run> {
    const [command, args] = this.sandboxed
      ? [join(launcherDir, "zenius"), ["nodejs", "--instance", context.instance]]
      : [process.execPath, [CLI, "nodejs", "--instance", context.instance]];
    return spawnRun(command, args, { stdin: code, env: this.#env() });
  }

  /** A shell command, with this CLI's `zenius` first on PATH. */
  shell(command: string): Promise<Run> {
    const env = this.#env();
    env.PATH = `${this.sandboxed ? launcherDir : shim}:${process.env.PATH}`;
    return spawnRun("bash", ["-c", command], { env });
  }

  /** Where an example's /absolute/path/ points: anywhere in a plain run, the current folder for a sandboxed upload. */
  readable(): string {
    return this.sandboxed ? work : files;
  }
}

/** The example's code with its placeholders filled in; each must still be there. */
function fill(code: string, ...pairs: [string, string][]): string {
  for (const [from, to] of pairs) {
    assert.ok(code.includes(from), `the example no longer contains ${JSON.stringify(from)}: update its check in examples.it.ts`);
    code = code.split(from).join(to);
  }
  return code;
}

function ok(run: Run): Run {
  assert.equal(run.code, 0, `exit ${run.code}\n--- stderr ---\n${run.stderr}\n--- stdout ---\n${run.stdout}`);
  return run;
}

/** The JSON the script printed last. */
function lastJson(run: Run): any {
  for (const line of run.stdout.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // not the script's JSON
    }
  }
  assert.fail(`no JSON in the output:\n${run.stdout}\n${run.stderr}`);
}

/** A script that fails the way the guide says: the code, and its next step. */
function refusedPath(run: Run): void {
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\[ZEN_PATH_NOT_ALLOWED\]/);
  assert.match(run.stderr, /relative path/);
}

/** The files a sandboxed run lists after its output, as the guide says. */
function listedFiles(run: Run): string[] {
  const block = /\[zenius:files\]\n((?:Wrote .+\n?)+)/.exec(run.stdout)?.[1] ?? "";
  return [...block.matchAll(/^Wrote (.+)$/gm)].map((match) => match[1]!);
}

/** A new task space whose Page p1 shows `path`, as the examples' scripts begin. */
function opened(path: string, name = unique("it example")): { name: string; code: string } {
  return {
    name,
    code: `const task = await taskSpace(${JSON.stringify(name)});\nconst page = task.page("p1");\nawait page.goto(${JSON.stringify(context.base + path)});\n`,
  };
}

/** A task space made for an example, with p1 on `path`; then `extra` runs on it. Returns its id. */
async function space(path: string, extra = ""): Promise<{ id: number; name: string }> {
  const { name, code } = opened(path);
  const made = await zeniusJson<{ id: number }>(context, `${code}${extra}\nconsole.log(JSON.stringify({ id: task.spaceId }));`);
  return { id: made.id, name };
}

/** Ends the task spaces the examples name themselves, whoever controls them. */
async function finishNamed(): Promise<void> {
  await zeniusJson(
    context,
    `for (const entry of await listTaskSpaces()) {
  if (!${JSON.stringify(NAMED)}.includes(entry.name)) continue;
  const task = entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id) : entry.ownership === "agent" ? await taskSpace(entry.id) : null;
  if (task) await task.finish({ keep: [] });
}
console.log("{}");`,
  );
}

/** Finish the space an example left in the agent's control. */
const FINISH = `\nawait task.finish({ keep: [] });`;

type Check = { skip?: string; run?: (r: Runner, block: Block, t: TestContext) => Promise<void> };

const CHECKS: Record<string, Check> = {
  // SKILL.md: the bootstrap.
  "zenius skill": {
    run: async (r, block) => {
      const run = ok(await r.shell(block.code));
      const lines = run.stdout.trimEnd().split("\n");
      assert.match(lines[0]!, /^\[zenius:skill\] zenius usage guide v\d+\.\d+\.\d+/);
      assert.match(lines.at(-1)!, /^\[zenius:skill\] end of guide v\d+\.\d+\.\d+$/);
    },
  },

  // guide.md, "Run browser scripts".
  "zenius nodejs <<'EOF'": {
    run: async (r, block) => {
      try {
        const run = ok(await r.shell(fill(block.code, ["https://example.com", `${context.base}/ex-example`])));
        assert.match(run.stdout, /\{ taskSpaceId: \d+, page: 'p1' \}/);
        assert.match(run.stdout, /heading[^\n]*\n\s+text "Example Domain"/);
      } finally {
        await finishNamed();
      }
    },
  },

  // "Spaces, rounds, and pages": a tab the space holds without a label, as
  // after a claim, is adopted.
  "const active = (await task.tabs()).find((item) => item.active);": {
    run: async (r, block, t) => {
      if (!needs(t, context, "dev.answerClaim")) return;
      const kept = await space("/two", `await task.finish({ keep: ["p1"] });`);
      const [run] = await Promise.all([r.script(`const task = await claimTaskSpace(${kept.id});\n${block.code}${FINISH}`), answerClaims(context, [kept.id])]);
      ok(run);
      assert.match(run.stdout, new RegExp(String.raw`\{ page: 'p\d+', url: '${context.base}/two' \}`));
    },
  },

  // "Semantic pages": a subtree snapshot of an iframe, by the ref on its line.
  'console.log(await page.snapshot({ scope: "subtree", root: "@12" }));': {
    run: async (r, block) => {
      const { name, code } = opened("/framed");
      // By id: the frame's own script holds the button's text too, which an older runtime's text= doesn't skip.
      const first = ok(await r.script(`${code}await page.waitForSelector("#in-frame");\nconsole.log(await page.snapshot());`));
      const ref = /iframe \[ref=(\d+)\]/.exec(first.stdout)?.[1];
      assert.ok(ref, first.stdout);
      const run = ok(await r.script(`const task = await taskSpace(${JSON.stringify(name)});\nconst page = task.page("p1");\n${fill(block.code, ["@12", `@${ref}`])}${FINISH}`));
      const rounds = `--- round 1 ---\n${first.stdout}--- round 2 ---\n${run.stdout}`;
      assert.match(run.stdout, /button \[ref=\d+\]\n\s+text "inside the frame"/, rounds);
      assert.doesNotMatch(run.stdout, /text "outer"/, rounds);
    },
  },

  'await page.waitForFunction(() => document.body.innerText.includes("Done"), undefined, { timeout: 5000 });': {
    run: async (r, block) => {
      // The example's call shape, waiting for text that arrives late, and what
      // the text says it returns. Its condition reads the DOM only, not the
      // page's own globals.
      const code = block.code.replace('"Done"', '"arrived late"');
      assert.notEqual(code, block.code, "the example's text to wait for");
      const run = ok(
        await r.script(
          `${opened("/late").code}${code}\nconsole.log(JSON.stringify({ arrived: await page.evaluate(() => !!document.querySelector("#late")), returns: await page.waitForFunction(() => 42, undefined, { timeout: 5000 }) }));${FINISH}`,
        ),
      );
      assert.deepEqual(lastJson(run), { arrived: true, returns: true });
    },
  },

  // A round that acts on the previous round's refs.
  "// Next round: act using the previous output, verify, then prepare the next round.": {
    run: async (r, block) => {
      const { name, code } = opened("/ex-signin");
      const first = ok(await r.script(`${code}console.log(await page.snapshot());`));
      // The label's text comes first, as a line of its own.
      const ref = /text "Email"\n\s+textbox \[ref=(\d+)/.exec(first.stdout)?.[1];
      assert.ok(ref, first.stdout);
      const run = ok(await r.script(`const task = await taskSpace(${JSON.stringify(name)});\n${fill(block.code, ["@21", `@${ref}`])}${FINISH}`));
      assert.match(run.stdout, /heading[^\n]*\n\s+text "Account home"/);
    },
  },

  'await page.selectOption("select[name=month]", { label: "October" });': {
    run: async (r, block) => {
      const run = ok(await r.script(`${opened("/ex-month").code}${block.code}\nconsole.log(JSON.stringify({ value: await page.evaluate(() => document.querySelector("select[name=month]").value) }));${FINISH}`));
      assert.deepEqual(lastJson(run), { value: "m10" });
    },
  },

  // "Visual pages": a screenshot, then the mouse and the keyboard.
  'const path = await page.screenshot({ path: "/absolute/path/before.png" });': {
    run: async (r, block) => {
      const typed = `\nconsole.log(JSON.stringify({ typed: await page.evaluate(() => document.querySelector("#cell").value) }));${FINISH}`;
      if (r.sandboxed) {
        // As written, an absolute path: the sandbox refuses it, as the guide says.
        refusedPath(await r.script(`${opened("/ex-visual").code}${block.code}`));
        const run = ok(await r.script(`${opened("/ex-visual").code}${fill(block.code, ["/absolute/path/", ""])}${typed}`));
        const [listed] = listedFiles(run);
        assert.equal(listed, join(working, "before.png"), run.stdout);
        assert.ok(run.stdout.includes(`{ screenshot: '${listed}' }`), run.stdout);
        assert.ok(readFileSync(listed!).subarray(1, 4).toString() === "PNG");
        assert.deepEqual(lastJson(run), { typed: "hello" });
        return;
      }
      const run = ok(await r.script(`${opened("/ex-visual").code}${fill(block.code, ["/absolute/path/", `${files}/`])}${typed}`));
      assert.ok(run.stdout.includes(`{ screenshot: '${files}/before.png' }`), run.stdout);
      assert.equal(readFileSync(join(files, "before.png")).subarray(1, 4).toString(), "PNG");
      assert.deepEqual(lastJson(run), { typed: "hello" });
    },
  },

  "const rows = await page.evaluate(": {
    run: async (r, block) => {
      const run = ok(await r.script(`${opened("/ex-articles").code}${block.code}\nconsole.log(JSON.stringify(rows));${FINISH}`));
      assert.deepEqual(
        lastJson(run),
        [1, 2, 3].map((n) => ({ text: `Story ${n}`, href: `${context.base}/two?n=${n}` })),
      );
    },
  },

  'const popupPromise = page.waitForEvent("popup");': {
    run: async (r, block) => {
      const run = ok(await r.script(`${opened("/popup").code}${block.code}\nconsole.log(JSON.stringify({ label: popupPage.label, url: await popupPage.url() }));${FINISH}`));
      assert.deepEqual(lastJson(run), { label: "p2", url: `${context.base}/two` });
    },
  },

  // A prompt the previous action opened, answered.
  'await page.acceptDialog("prompt response");': {
    run: async (r, block) => {
      const run = ok(
        await r.script(
          `${opened("/dialogs").code}const receipt = await page.click("#prompt");\nconsole.log(JSON.stringify({ dialog: receipt.dialog?.type }));\n${block.code}\nconsole.log(JSON.stringify({ answer: await page.evaluate(() => ${noted("answer")}) }));${FINISH}`,
        ),
      );
      assert.ok(run.stdout.includes('{"dialog":"prompt"}'), run.stdout);
      assert.deepEqual(lastJson(run), { answer: "prompt response" });
    },
  },

  // "Files and requests". Uploads may come from the working folder in the sandbox.
  'await page.setInputFiles("input[type=file]", ["/absolute/path/report.pdf"]);': {
    run: async (r, block) => {
      const run = ok(await r.script(`${opened("/ex-upload").code}${fill(block.code, ["/absolute/path/", `${r.readable()}/`])}\nconsole.log(JSON.stringify(await page.evaluate(() => ${noted("picked")})));${FINISH}`));
      assert.deepEqual(lastJson(run), ["report.pdf:24"]);
    },
  },

  "const chooserPromise = page.waitForFileChooser({ timeout: 10_000 });": {
    run: async (r, block) => {
      const run = ok(await r.script(`${opened("/ex-chooser").code}${fill(block.code, ["/absolute/path/", `${r.readable()}/`])}\nconsole.log(JSON.stringify({ dialog: result?.dialog ?? null, chosen: await page.evaluate(() => ${noted("chosen")}) }));${FINISH}`));
      assert.deepEqual(lastJson(run), { dialog: null, chosen: ["report.pdf"] });
    },
  },

  'const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });': {
    run: async (r, block) => {
      const printed = `{ url: '${context.base}/file.txt', name: 'report.txt' }`;
      if (r.sandboxed) {
        const refused = await r.script(`${opened("/ex-download").code}${block.code}`);
        assert.ok(refused.stdout.includes(printed), refused.stdout);
        refusedPath(refused);
        const run = ok(await r.script(`${opened("/ex-download").code}${fill(block.code, ["/absolute/path/", ""])}${FINISH}`));
        const [listed] = listedFiles(run);
        assert.equal(listed, join(working, "report.pdf"), run.stdout);
        assert.equal(readFileSync(listed!, "utf8"), "zenius download fixture\n");
        return;
      }
      const run = ok(await r.script(`${opened("/ex-download").code}${fill(block.code, ["/absolute/path/", `${files}/`])}${FINISH}`));
      assert.ok(run.stdout.includes(printed), run.stdout);
      assert.equal(readFileSync(join(files, "report.pdf"), "utf8"), "zenius download fixture\n");
    },
  },

  'const response = await page.fetch("/api/items", {': {
    run: async (r, block) => {
      const run = ok(await r.script(`${opened("/").code}${block.code}\nconsole.log(JSON.stringify({ ok: response.ok, status: response.status, body: JSON.parse(response.body) }));${FINISH}`));
      assert.deepEqual(lastJson(run), { ok: true, status: 200, body: { method: "POST", type: "application/json", received: '{"limit":20}' } });
    },
  },

  'await page.fetch("/image.png", { saveAs: "/absolute/path/image.png" });': {
    run: async (r, block) => {
      if (r.sandboxed) {
        refusedPath(await r.script(`${opened("/").code}${block.code}`));
        const run = ok(await r.script(`${opened("/").code}${fill(block.code, ["/absolute/path/", ""])}${FINISH}`));
        const [listed] = listedFiles(run);
        assert.equal(listed, join(working, "image.png"), run.stdout);
        assert.deepEqual(readFileSync(listed!), FIXTURE_PNG);
        return;
      }
      ok(await r.script(`${opened("/").code}${fill(block.code, ["/absolute/path/", `${files}/`])}${FINISH}`));
      assert.deepEqual(readFileSync(join(files, "image.png")), FIXTURE_PNG);
    },
  },

  // "Starting and ending a reply": each branch of the first script.
  "const SPACE_ID = 7; // printed by your last reply about this goal; null for a new goal": {
    run: async (r, block, t) => {
      const start = (id: string) => fill(block.code, ["const SPACE_ID = 7;", `const SPACE_ID = ${id};`]);
      const printed = (run: Run, page = "p1") => assert.match(run.stdout, new RegExp(String.raw`taskSpaceId: \d+,\s+page: '${page}',\s+tabs: \[`), run.stdout);
      try {
        printed(ok(await r.script(`${start("null")}${FINISH}`)));
      } finally {
        await finishNamed();
      }
      const ours = await space("/two");
      printed(ok(await r.script(`${start(String(ours.id))}${FINISH}`)));
      const handed = await space("/two", "await task.handOff();");
      printed(ok(await r.script(`${start(String(handed.id))}${FINISH}`)));
      if (!needs(t, context, "dev.answerClaim")) return;
      const kept = await space("/two", `await task.finish({ keep: ["p1"] });`);
      const [claimed] = await Promise.all([r.script(`${start(String(kept.id))}${FINISH}`), answerClaims(context, [kept.id])]);
      printed(ok(claimed), "p\\d+");
    },
  },

  // finish(): the default closes the space; the exception keeps one Page.
  "const task = await taskSpace(7); // the taskSpaceId printed earlier in this reply": {
    run: async (r, block) => {
      const listed = async (id: number) =>
        (await zeniusJson<{ id: number; ownership: string }[]>(context, `console.log(JSON.stringify((await listTaskSpaces()).filter((s) => s.id === ${id})))`))[0];
      const closed = await space("/two");
      ok(await r.script(fill(block.code, ["taskSpace(7)", `taskSpace(${closed.id})`])));
      assert.equal(await listed(closed.id), undefined);
      const keeping = await space("/two", `await (await task.newPage()).goto(${JSON.stringify(`${context.base}/`)});`);
      const exception = fill(
        block.code,
        ["taskSpace(7)", `taskSpace(${keeping.id})`],
        ["await task.finish({ keep: [] });", "// (the default, not run here)"],
        ['// await task.finish({ keep: ["p2"] });', 'await task.finish({ keep: ["p2"] });'],
      );
      ok(await r.script(exception));
      assert.equal((await listed(keeping.id))?.ownership, "user");
    },
  },

  // "User control": resuming a space handed to the user.
  "const task = await takeOverTaskSpace(7);": {
    run: async (r, block) => {
      const handed = await space("/two", "await task.handOff();");
      const run = ok(
        await r.script(
          `${fill(block.code, ["takeOverTaskSpace(7)", `takeOverTaskSpace(${handed.id})`])}\nconsole.log(JSON.stringify({ url: await userPage.url() }));${FINISH}`,
        ),
      );
      assert.deepEqual(lastJson(run), { url: `${context.base}/two` });
    },
  },

  // references/clearing-state.md: one origin's storage, cleared, and nothing
  // refused: a task's pages don't use the site's service worker, so asking
  // for its registrations would only report serviceWorker.
  "await page.evaluate(async () => {": {
    run: async (r, block) => {
      // Seeded once, by the setup: a page that seeds itself would do it again at the example's reload.
      const seeded = `await page.evaluate(async () => {
  localStorage.setItem("seen", "1");
  sessionStorage.setItem("tab", "1");
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("ex-db", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("items");
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
});\n`;
      const counts = `\nconst stored = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: (await indexedDB.databases()).length }));
const refused = (await page.events()).filter((event) => event.method === "Zenius.refused").map((event) => event.params.kind);
console.log(JSON.stringify({ ...stored, refused }));${FINISH}`;
      // The events buffered before the example are read away first.
      const run = ok(await r.script(`${opened("/ex-storage").code}${seeded}await page.events();\n${block.code}${counts}`));
      assert.deepEqual(lastJson(run), { local: 0, session: 0, databases: 0, refused: [] });
    },
  },

  // references/feedback.md: the report. This lane's profile has no agent
  // sidebar (zen-dev.sh leaves its scripts out), so no card can open and the
  // command writes a draft: in a zenius home of the check's own for the plain
  // CLI, never the user's, and in the working folder in the sandbox.
  // tests/core/feedback.test.mjs answers the card itself.
  'zenius feedback "clicking a button inside a shadow root failed twice with ZEN_INTERNAL"': {
    run: async (r, block, t) => {
      if (!needs(t, context, "feedback.compose", "feedback.propose")) return;
      const home = join(root, `feedback-${r.mode}`);
      const command = r.sandboxed ? block.code : `ZENIUS_HOME='${home}' ZENIUS_SOCKET='${socketPath(context.instance)}' ${block.code}`;
      const run = ok(await r.shell(command));
      const [first, , link] = run.stdout.split("\n");
      const file = /^No agent sidebar can show the report, so zenius feedback wrote the report as a draft: (.+)$/.exec(first!)?.[1];
      assert.ok(file?.startsWith(`${r.sandboxed ? working : join(home, "feedback")}/`), run.stdout);
      const draft = readFileSync(file!, "utf8");
      assert.ok(draft.includes("\n    clicking a button inside a shadow root failed twice with ZEN_INTERNAL\n"), draft);
      const form = new URL(link!);
      assert.equal(`${form.origin}${form.pathname}`, "https://github.com/zhuconv/zenius/issues/new");
      assert.deepEqual([...form.searchParams.keys()], ["template", "title"]);
    },
  },

  // references/install.md: Codex's view of the Skill. It runs Codex, not
  // zenius, and sdk-it makes no Codex calls.
  "command codex debug prompt-input hi | grep -o -- '- zenius: [^\\]*'": {
    skip: "runs Codex: checked by hand, offline, with a scratch CODEX_HOME",
  },

  // references/install.md: the release's installer. It downloads from
  // GitHub, which tests never reach; sdk/test/release.test.ts runs the
  // installer scripts/release.sh builds, against a local copy of the asset.
  "curl -fsSL https://github.com/zhuconv/zenius/releases/latest/download/install.sh | bash": {
    skip: "downloads the release from GitHub: sdk/test/release.test.ts runs the same installer offline",
  },
};

/** On the Mac a miss would reach macOS's own consent prompts, so those probes skip there, as the observe layer's vectors do. */
const MAC_MISS = process.platform === "darwin";

/**
 * The guide's list of what a task's pages refuse ("Action receipts, popups,
 * and dialogs"), one probe per line, keyed by the line's words before its
 * kinds. A probe makes the page try what the line names, on a fixture page,
 * and pushes each of the page's answers to `answers`. The page must give
 * exactly those answers, the line must name each of them, and the page's
 * events must hold a Zenius.refused event of each kind in the line's
 * parentheses.
 */
const REFUSAL_PROBES: Record<string, { answers: string[]; code: string; skip?: string | false }> = {
  "Camera, microphone, screen, speech": {
    answers: ["NotAllowedError"],
    skip: MAC_MISS && "a miss would ask macOS for the camera",
    code: `answers.push(await page.evaluate('navigator.mediaDevices.getUserMedia({ video: true }).then(() => "allowed", (e) => e.name)'));`,
  },
  // Evidence: the agent's code leaves a style sheet in the page.
  "Location, MIDI on a page with your code or a flag": {
    answers: ["PERMISSION_DENIED"],
    skip: MAC_MISS && "a miss would ask macOS for the location",
    code: `await page.evaluate(() => { document.head.append(document.createElement("style")); });
answers.push(await page.evaluate('new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("a position"), (e) => resolve(e.code === e.PERMISSION_DENIED ? "PERMISSION_DENIED" : "code " + e.code)))'));`,
  },
  // The agent's own, on any page: the fixture's site has no grant, so a miss
  // would fire the native's error event, never show.
  "Notifications from your code": {
    answers: ["NotAllowedError"],
    code: `answers.push(await page.evaluate('(() => { try { new Notification("zenius").close(); return "made"; } catch (e) { return e.name; } })()'));`,
  },
  WebRTC: {
    answers: ["NotAllowedError"],
    skip: MAC_MISS && "a miss would gather the Mac's local addresses, which can ask macOS about the local network",
    code: `answers.push(await page.evaluate('(() => { try { new RTCPeerConnection().close(); return "made"; } catch (e) { return e.name; } })()'));`,
  },
  "Private, link-local and `.local` hosts": {
    answers: ["TypeError", "net::ERR_ACCESS_DENIED"],
    skip: MAC_MISS && "a miss would ask macOS about the local network",
    // 172.31.254.1, as the observe layer's vectors use: private, and routed nowhere here.
    code: `answers.push(await page.evaluate('fetch("http://172.31.254.1/").then((r) => "status " + r.status, (e) => e.name)'));
answers.push(await page.goto("http://172.31.254.1/").then(() => "loaded", (e) => /net::ERR_[A-Z_]+/.exec(String(e.message))?.[0] ?? String(e.code)));`,
  },
  "Service workers, Cache writes": {
    answers: ["SecurityError", "SecurityError"],
    code: `answers.push(await page.evaluate('navigator.serviceWorker.register("/zenius-sw.js").then(() => "registered", (e) => e.name)'));
answers.push(await page.evaluate('caches.open("zenius").then((cache) => cache.put("/zenius", new Response("x"))).then(() => "stored", (e) => e.name)'));`,
  },
};

type RefusalLine = { key: string; kinds: string[]; text: string };

/** guide.md with its paragraphs' lines joined, as an agent reads the sentences. */
function guideText(): string {
  return readFileSync(join(ROOT, "skill/guide.md"), "utf8").replace(/\n(?=[^\n-])/g, " ");
}

/** The list's lines, each joined into one, with its key and kinds. */
function refusalLines(): RefusalLine[] {
  const text = readFileSync(join(ROOT, "skill/guide.md"), "utf8");
  const start = text.indexOf("In a task's pages zenius also refuses");
  assert.ok(start >= 0, "guide.md no longer has its list of what a task's pages refuse");
  const list = text.slice(start).split("\n\n")[1] ?? "";
  return list.split(/\n(?=- )/).map((item) => {
    const line = item.replace(/\n\s+/g, " ").replace(/^- /, "");
    const match = /^(.+?) \(((?:`\w+`(?:, )?)+)\)/.exec(line);
    assert.ok(match, `a line without its kinds in parentheses: ${line}`);
    return { key: match[1]!, kinds: [...match[2]!.matchAll(/`(\w+)`/g)].map((kind) => kind[1]!), text: line };
  });
}

/** A task on a fixture page runs the probe, then gathers the refused kinds the page's events hold. */
function refusalScript(line: RefusalLine, code: string): string {
  return `${opened("/ex-example").code}await page.events();
const answers = [];
${code}
const kinds = new Set();
const messages = [];
for (const end = Date.now() + 5000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
  for (const event of await page.events()) {
    if (event.method !== "Zenius.refused") continue;
    kinds.add(event.params.kind);
    messages.push(event.params.message);
  }
  if (${JSON.stringify(line.kinds)}.every((kind) => kinds.has(kind)) || Date.now() > end) break;
}
await task.finish({ keep: [] });
console.log(JSON.stringify({ answers, kinds: [...kinds], messages }));`;
}

// After the task the tab is the user's: these reach it from chrome, as the
// user's own clicks and the user's own page code would.

const FIND_TAB = `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find((t) => t.linkedBrowser?.currentURI?.spec === arg.url);
if (!tab) throw new Error("no tab shows " + arg.url);`;

/** Runs `code` in the page's own world in the tab showing `url`. */
function inTab(url: string, code: string): Promise<unknown> {
  return context.rpc.call("dev.evalChrome", {
    code: `${FIND_TAB}\nreturn await ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code });`,
    arg: { url, code },
  });
}

/** The user's reload, Back or Forward in the tab showing `url`; resolves once another document, showing `to`, has loaded. */
function userNavigates(url: string, how: "reload" | "goBack" | "goForward", to: string): Promise<unknown> {
  return context.rpc.call("dev.evalChrome", {
    code: `${FIND_TAB}
const browser = tab.linkedBrowser;
const before = browser.browsingContext.currentWindowGlobal?.innerWindowId;
if (arg.how === "reload") browser.reload();
else browser[arg.how](false);
for (const end = Date.now() + 15000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
  const current = browser.browsingContext.currentWindowGlobal;
  if (current && current.innerWindowId !== before && browser.currentURI.spec === arg.to && !browser.webProgress?.isLoadingDocument) return true;
}
throw new Error(arg.how + " didn't bring " + arg.to);`,
    arg: { url, how, to },
  });
}

/** Closes what a probe left: the tabs showing these URLs. */
function closeTabs(urls: string[]): Promise<unknown> {
  return context.rpc.call("dev.evalChrome", {
    code: `for (const tab of [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].filter((t) => arg.includes(t.linkedBrowser?.currentURI?.spec))) win.gBrowser.removeTab(tab);
return true;`,
    arg: urls,
  });
}

/** A path on the fixture page no other test uses. */
const probePath = (tag: string) => `/ex-example?${tag}=${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** A write the refusals stop: "stored" where the page may write, SecurityError where it may not. */
const CACHE_WRITE = `caches.open("zenius-probe").then((cache) => cache.put("/zenius-probe", new Response("x"))).then(() => caches.delete("zenius-probe")).then(() => "stored", (e) => e.name)`;

/** A mark in the document itself: a restored document still has it, one loaded afresh doesn't. */
const MARK = (value: string) => `document.documentElement.setAttribute("data-zenius-probe", ${JSON.stringify(value)})`;
const READ_MARK = `document.documentElement.getAttribute("data-zenius-probe") ?? "afresh"`;

describe("the guide's lines on what a task's pages refuse", () => {
  const lines = refusalLines();

  it("each line has a probe here, and each probe a line", () => {
    assert.ok(lines.length >= 5, `found ${lines.length} lines`);
    assert.deepEqual(
      lines.filter((line) => !Object.hasOwn(REFUSAL_PROBES, line.key)).map((line) => line.key),
      [],
      "lines without a probe: add one to REFUSAL_PROBES in examples.it.ts",
    );
    assert.deepEqual(
      Object.keys(REFUSAL_PROBES).filter((key) => !lines.some((line) => line.key === key)),
      [],
      "probes whose line is gone",
    );
    for (const line of lines) {
      for (const answer of new Set(REFUSAL_PROBES[line.key]?.answers)) {
        assert.ok(line.text.includes(answer), `"${line.key}" doesn't name the page's answer ${answer}`);
      }
    }
  });

  for (const mode of ["plain", "sandboxed"] as const) {
    describe(mode, () => {
      for (const line of lines) {
        const probe = REFUSAL_PROBES[line.key];
        const skip = probe?.skip || (mode === "sandboxed" && !SANDBOX ? "needs bubblewrap that works here, or macOS's sandbox-exec" : false);
        it(line.key, { skip }, async () => {
          assert.ok(probe, "no probe");
          const out = lastJson(ok(await new Runner(mode).script(refusalScript(line, probe.code))));
          assert.deepEqual(out.answers, probe.answers, JSON.stringify(out));
          for (const kind of line.kinds) assert.ok(out.kinds.includes(kind), `no Zenius.refused ${kind}: ${JSON.stringify(out)}`);
        });
      }
    });
  }

  // What happens after the task, from chrome as the user's own tab: the CLI's
  // mode changes nothing there, so each runs once.

  it("a page you keep, where your code ran, keeps the refusals until a reload replaces it", async (t) => {
    const says = "A page you keep or release, if your code wrote into it, keeps these refusals until a load or reload replaces it";
    assert.ok(guideText().includes(says), `guide.md no longer says "${says}": update this probe`);
    if (!needs(t, context, "dev.evalChrome")) return;
    const { code } = opened(probePath("kept"));
    const url = /page\.goto\("([^"]+)"\)/.exec(code)![1]!;
    try {
      // The probe's code writes into the page: with page code in a sandbox, a
      // page it only read keeps no refusals after the task (the observe layer).
      // Landing (2) reloads a written kept page at the finish; with the quiet
      // reload off, the page stays written, standing in for a failed reload.
      await context.rpc.call("dev.evalChrome", { code: `Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;` });
      ok(await new Runner("plain").script(`${code}await page.evaluate(() => { document.body.dataset.agent = "wrote"; });\nawait task.finish({ keep: ["p1"] });\nconsole.log("{}");`));
      const kept = await inTab(url, CACHE_WRITE);
      await userNavigates(url, "reload", url);
      const reloaded = await inTab(url, CACHE_WRITE);
      assert.deepEqual({ kept, reloaded }, { kept: "SecurityError", reloaded: "stored" });
    } finally {
      await context.rpc.call("dev.evalChrome", { code: `Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;` }).catch(() => {});
      await closeTabs([url]);
    }
  });

  // The sandbox's routes into the page's own JavaScript run there and mark
  // the page hooked, instead of failing the call.
  it("code you hand the page itself runs there, and the call doesn't fail", async () => {
    const says = "Code you hand the page itself (`<script>`, `eval()`, string timers) runs there";
    assert.ok(guideText().includes(says), `guide.md no longer says "${says}": update this probe`);
    const { code } = opened(probePath("pageworld"));
    const out = lastJson(
      ok(
        await new Runner("plain").script(`${code}const ran = await page.evaluate(async () => {
  const root = document.documentElement;
  const script = document.createElement("script");
  script.textContent = 'document.documentElement.setAttribute("data-zenius-script", "ran")';
  document.head.append(script);
  setTimeout('document.documentElement.setAttribute("data-zenius-timer", "ran")', 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return [root.getAttribute("data-zenius-script"), root.getAttribute("data-zenius-timer")];
});${FINISH}
console.log(JSON.stringify({ ran }));`),
      ),
    );
    assert.deepEqual(out.ran, ["ran", "ran"]);
  });

  it("a tab that leaves or joins a task loads its Back and Forward pages afresh; within the task they come from the cache", async (t) => {
    const says = "When a tab joins or leaves your task, its Back and Forward pages load afresh";
    const limits = readFileSync(join(ROOT, "skill/zenius/references/limits.md"), "utf8");
    assert.ok(limits.includes(says), `references/limits.md no longer says "${says}": update this probe`);
    if (!needs(t, context, "dev.evalChrome", "dev.answerClaim")) return;
    const { code } = opened(probePath("bf-a"));
    const a = /page\.goto\("([^"]+)"\)/.exec(code)![1]!;
    const b = context.base + probePath("bf-b");
    const at = (url: string) => `new RegExp(${JSON.stringify(url.replace(/[.?]/g, "\\$&"))})`;
    try {
      // Within the task, Back restores A, mark and all; then the task keeps the tab on B.
      // Gecko caches a page only once its load has ended, and under load it
      // can still skip one (seen in sdk-it on Linux), so A gets 3 tries: a
      // miss in each means zenius empties the cache within a task.
      const left = lastJson(
        ok(
          await new Runner("plain").script(`${code}const loadEnded = () => (performance.getEntriesByType("navigation")[0]?.loadEventEnd ?? 0) > 0;
const attempts = [];
for (let i = 0; i < 3 && attempts.at(-1) !== "the agent's"; i++) {
  if (i > 0) await page.goto(${JSON.stringify(a)});
  await page.waitForFunction(loadEnded);
  await page.evaluate(${JSON.stringify(MARK("the agent's"))});
  await page.goto(${JSON.stringify(b)});
  await page.evaluate("history.back()");
  await page.waitForURL(${at(a)});
  attempts.push(await page.evaluate(${JSON.stringify(READ_MARK)}));
  await page.evaluate("history.forward()");
  await page.waitForURL(${at(b)});
}
await task.finish({ keep: ["p1"] });
console.log(JSON.stringify({ id: task.spaceId, within: attempts.at(-1), attempts }));`),
        ),
      );
      if (left.attempts.length > 1) t.diagnostic(`within the task, Back restored A from the cache only at try ${left.attempts.length}: ${JSON.stringify(left.attempts)}`);
      // The tab left the task: the user's Back loads A afresh.
      await userNavigates(b, "goBack", a);
      const afterLeave = await inTab(a, READ_MARK);
      // The user marks A and goes Forward, so A waits in the cache, then a claim adopts the tab back into a task.
      await inTab(a, MARK("the user's"));
      await userNavigates(a, "goForward", b);
      const [joined] = await Promise.all([
        new Runner("plain").script(`const task = await claimTaskSpace(${left.id});
const page = (await task.pages())[0] ?? (await task.adopt((await task.tabs())[0].page));
await page.evaluate("history.back()");
await page.waitForURL(${at(a)});
const afterJoin = await page.evaluate(${JSON.stringify(READ_MARK)});
await task.finish({ keep: [] });
console.log(JSON.stringify({ afterJoin }));`),
        answerClaims(context, [left.id]),
      ]);
      const { afterJoin } = lastJson(ok(joined));
      assert.deepEqual({ within: left.within, afterLeave, afterJoin }, { within: "the agent's", afterLeave: "afresh", afterJoin: "afresh" });
    } finally {
      await closeTabs([a, b]);
    }
  });
});

describe("the Skill's code examples", () => {
  it("each has a check here, and each check an example", () => {
    const firsts = BLOCKS.map((block) => block.first);
    assert.ok(BLOCKS.length >= 20, `found ${BLOCKS.length} code blocks`);
    assert.deepEqual(
      BLOCKS.filter((block) => !Object.hasOwn(CHECKS, block.first)).map((block) => `${block.file}:${block.line} ${block.first}`),
      [],
      "examples without a check: add one to CHECKS in examples.it.ts",
    );
    assert.deepEqual(Object.keys(CHECKS).filter((first) => !firsts.includes(first)), [], "checks whose example is gone");
    assert.equal(new Set(firsts).size, firsts.length, "two examples start with the same line");
  });

  for (const mode of ["plain", "sandboxed"] as const) {
    describe(mode, () => {
      for (const block of BLOCKS) {
        const check = CHECKS[block.first];
        const skip = check?.skip ?? (mode === "sandboxed" && !SANDBOX ? "needs bubblewrap that works here, or macOS's sandbox-exec" : false);
        it(`${block.file}:${block.line} ${block.first.slice(0, 60)}`, { skip }, async (t) => {
          assert.ok(check?.run, "no check");
          await check.run(new Runner(mode), block, t);
        });
      }
    });
  }
});
