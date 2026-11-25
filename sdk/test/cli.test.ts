// The real `zenius` command against the mock runtime: script semantics,
// output conventions, exit codes and the other subcommands.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { guardHome } from "../../tests/lib/scratch-home.mjs";
import { hookedNotice } from "../src/page.ts";
import { runCli } from "./helpers.ts";
import { Hooked, MockError, MockRuntime } from "./mock-runtime.ts";

let mock: MockRuntime;
before(async () => {
  mock = await new MockRuntime().start();
});
after(async () => {
  await mock.stop();
});

const run = (script: string, args: string[] = []) => runCli(["nodejs", ...args], { stdin: script, socketPath: mock.socketPath });

describe("zenius nodejs", () => {
  it("runs a heredoc with the globals preloaded and top-level await", async () => {
    const result = await run(`
const task = await taskSpace("cli demo");
const page = task.page("p1");
await page.goto("https://example.com/");
console.log({ taskSpaceId: task.spaceId, page: page.label });
console.log(await page.snapshot());
`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^\{ taskSpaceId: \d+, page: 'p1' \}\n\[p1 "Title of https:\/\/example.com\/"/);
  });

  it("leaves the run's finished downloads in the working folder when it exits: only the script's own delete() deletes one", async () => {
    const start = mock.requests.length;
    const result = await run(`const page = (await taskSpace("cli downloads")).page("p1");
const kept = page.waitForEvent("download");
await page.click("button.download");
await (await kept).saveAs("${join(mock.dir, "saved.pdf")}");
const gone = page.waitForEvent("download");
await page.click("button.download");
await (await gone).delete();
console.log("done");`);
    assert.equal(result.code, 0, result.stderr);
    const requests = mock.requests.slice(start);
    const saved = requests.find((request) => request.method === "download.path")!.params.download;
    const deletes = requests.filter((request) => request.method === "download.delete").map((request) => request.params.download);
    // The script deleted one itself, and the CLI deletes nothing more.
    assert.equal(deletes.length, 1, JSON.stringify(deletes));
    assert.notEqual(deletes[0], saved);
    assert.equal(readFileSync(join(mock.dir, "saved.pdf"), "utf8"), `download ${saved}`);
    assert.equal(readFileSync(join(mock.workingDir, "report.pdf"), "utf8"), `download ${saved}`, "the file stays in the working folder");
  });

  it("never shows Node's warning about the vm loader, and shows every other warning", async () => {
    // Node 23 emits it at the script's first import(), after the script compiled.
    const result = await run(`await import("node:path");
process.emitWarning("vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time", "ExperimentalWarning");
process.emitWarning("keep this one", "UserWarning");
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("done");`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "done\n");
    assert.doesNotMatch(result.stderr, /USE_MAIN_CONTEXT_DEFAULT_LOADER/);
    assert.match(result.stderr, /UserWarning: keep this one/);
  });

  it("--timing prints each request and where the process's start went, in order", async () => {
    const result = await run("await listTaskSpaces()", ["--timing"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /^\[zenius:timing\] spaces\.list \d+\.\dms$/m);
    const startup = /^\[zenius:timing\] startup (.+) ms$/m.exec(result.stderr)?.[1];
    assert.ok(startup, result.stderr);
    const phases = startup.split(", ").map((phase) => {
      const [, name, at] = /^(.+) (\d+\.\d)$/.exec(phase)!;
      return { name, at: Number(at) };
    });
    assert.deepEqual(
      phases.map((phase) => phase.name).filter((name) => name !== "connected" && name !== "hello"),
      ["launcher", "bundle loaded", "script read", "first request"],
    );
    assert.ok(phases.every((phase, i) => i === 0 || phase.at >= phases[i - 1]!.at), startup);
    assert.ok(phases.some((phase) => phase.name === "hello"), "the mock sends a hello");
  });

  it("runs -e code", async () => {
    const result = await runCli(["nodejs", "-e", 'console.log("from -e", 1 + 1)'], { socketPath: mock.socketPath });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "from -e 2\n");
  });

  it("supports return, dynamic import and the Ego console prefixes", async () => {
    const result = await run(`
const { basename } = await import("node:path");
console.log(basename("/a/b.txt"));
console.warn("careful");
console.error("bad");
console.info({ nested: { deep: [1, 2, 3] } });
return;
console.log("never");
`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "b.txt\n[warn] careful\n[error] bad\n{ nested: { deep: [ 1, 2, 3 ] } }\n");
  });

  it("falls back to an ES module for static imports, keeping line numbers", async () => {
    const result = await run(`import { join } from "node:path";
console.log(join("a", "b"), typeof taskSpace);
throw new Error("line 3");`);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "a/b function\n");
    assert.match(result.stderr, /^Error: line 3\n {4}at script\.js:3:7$/m);
  });

  it("reports syntax errors with the script's line and column", async () => {
    const result = await run("const a = 1;\nconst b = ;\nconsole.log(a);\n");
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "SyntaxError: Script syntax error at line 2, column 11: Unexpected token ';'\n2 | const b = ;\n              ^\n",
    );
  });

  it("reports an unclosed bracket at the end of the script", async () => {
    const result = await run("console.log((1 + 2);\nfoo(");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /SyntaxError: Script syntax error at (line 1|the end of the script)/);
  });

  it("prints uncaught errors with their code and only the script's frames, after the script's output", async () => {
    const result = await run(`console.log("before");
const task = await taskSpace("cli errors");
await task.page("p1").click("#missing");`);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "before\n");
    assert.equal(
      result.stderr,
      // What happened, then what to do next (error-guide.ts), then the script's frame.
      'ZeniusError [ZEN_SELECTOR_NOT_FOUND]: page.click: selector "#missing" matched 0 elements\n' +
        "Take a snapshot() and target what it shows, by ref or by role and name; if the element is still to come, waitForSelector() first.\n" +
        "    at script.js:3:23\n",
    );
  });

  it("names the Node-versus-Page mistake", async () => {
    const result = await run("console.log(document.title);");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ReferenceError: document is not defined\. The script runs in Node\.js, not in the Page; .*page\.evaluate\(\)/);
  });

  it("validation errors carry the expected signature", async () => {
    const result = await run('await (await taskSpace("cli validation")).page("p1").fill("#a", "x", { label: "typing" });');
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^TypeError: page\.fill received unknown option: label\. Expected: await page\.fill\(selector, value, \{ clearFirst\?, timeout\? \}\)\n {4}at script\.js:1:/,
    );
  });

  it("a hard stop caught by the script replaces its output with the guidance", async () => {
    const space = mock.addSpace("cli delegated", "agentDelegatedToUser");
    mock.addPage(space);
    const result = await run(`console.log("business row");
const task = await taskSpace(${space.id});
try { await task.page("p1").click("#go"); } catch (error) { console.log("caught", error.code); }
console.log("after");`);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /business row|caught|after/);
    assert.match(result.stdout, /^Control of this task space is with the user/);
    assert.equal(result.stdout.match(/Control of this task space/g)?.length, 1);
  });

  it("keeps the script's output when the user hands the space back to its waitForControl after a caught hard stop", async () => {
    const space = mock.addSpace("cli taken then resumed", "agentDelegatedToUser");
    mock.addPage(space);
    space.resumeOnWait = true;
    const result = await run(`console.log("business row");
const task = await taskSpace(${space.id});
try { await task.page("p1").click("#go"); } catch (error) { console.log("caught", error.code); await task.waitForControl(); }
console.log("after");`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "business row\ncaught ZEN_TASK_SPACE_USER_IN_CONTROL\nafter\n");
  });

  it("keeps a space's hard stop when only another space is handed back", async () => {
    const held = mock.addSpace("cli held, not resumed", "agentDelegatedToUser");
    mock.addPage(held);
    const other = mock.addSpace("cli other, resumed", "agentDelegatedToUser");
    mock.addPage(other);
    other.resumeOnWait = true;
    const result = await run(`try { await (await taskSpace(${held.id})).page("p1").click("#go"); } catch {}
await (await taskSpace(${other.id})).waitForControl();
console.log("after");`);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /after/);
    assert.match(result.stdout, /^Control of this task space is with the user/);
  });

  it("an uncaught hard stop prints the guidance once, on stderr", async () => {
    const space = mock.addSpace("cli delegated 2", "agentDelegatedToUser");
    mock.addPage(space);
    const result = await run(`console.log("row");\nawait (await taskSpace(${space.id})).page("p1").goto("https://x.example/");`);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.match(/Control of this task space/g)?.length, 1);
    assert.match(result.stderr, /^ZeniusError \[ZEN_TASK_SPACE_USER_IN_CONTROL\]: page\.goto: Control/);
  });

  it("lists popups the script never handled after its output", async () => {
    const result = await run(`const task = await taskSpace("cli popups");
await task.page("p1").click("a.late-popup");
await new Promise((resolve) => setTimeout(resolve, 60));
console.log("clicked");`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "clicked\n[zenius:pages]\nUnhandled page p2 from p1: https://example.com/late\n");
  });

  it("says after the script's output what its page code left that loads a page afresh, for each call that hooked one, a failed call's too", async () => {
    const space = mock.addSpace("cli hooked", "agent");
    mock.addPage(space);
    mock.handle("page.evaluate", (params) => {
      if (String(params.fn).includes("throw")) throw Object.assign(new MockError("ZEN_EVALUATION_FAILED", "Error: after"), { hooked: "a style sheet" });
      return new Hooked(3, "a form");
    });
    try {
      const result = await run(`const page = (await taskSpace(${space.id})).page("p1");
console.log(await page.evaluate(() => 3));
try { await page.evaluate(() => { throw new Error("after"); }); } catch { console.log("caught"); }`);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        ["3", "caught", "[zenius:reload]", hookedNotice("page.evaluate", "p1", "a form"), "[zenius:reload]", hookedNotice("page.evaluate", "p1", "a style sheet"), ""].join("\n"),
      );
    } finally {
      mock.unhandle("page.evaluate");
    }
  });

  it("says once, on stderr, that the user paused the task space while actions waited", async () => {
    const result = await run(`const task = await taskSpace("cli held");
await task.page("p1").click("#held-1");
await task.page("p1").click("#held-2");
console.log("done");`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "done\n");
    assert.match(result.stderr, /^\[zenius\] The user paused task space \d+; your actions waited 0\.[2-9] s\. The page may have changed: take a fresh snapshot\.\n$/);
  });

  it("leaves the paused notice out when a hard stop already explains what happened", async () => {
    const space = mock.addSpace("cli held then delegated", "agentDelegatedToUser");
    mock.addPage(space);
    const result = await run(`await (await taskSpace("cli held 2")).page("p1").click("#held");
await (await taskSpace(${space.id})).page("p1").click("#go");`);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Control of this task space is with the user/);
    assert.doesNotMatch(result.stderr, /The user paused task space/);
  });

  it("help() prints by itself and returns the text", async () => {
    const result = await run('const text = help("page.click"); console.log(text.length > 0);');
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^Page\.click\n\nClick an element .*\n\nawait page\.click\(selector, .*\)\ntrue\n$/);
  });

  it("process.exit() inside a script still flushes its output", async () => {
    const result = await run('console.log("kept"); process.exit(3);');
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "kept\n");
  });

  it("does not wait for timers or waiters the script left behind", async () => {
    const result = await run(`const task = await taskSpace("cli dangling");
task.page("p1").waitForEvent("popup", { timeout: 5000 }).catch(() => {});
setTimeout(() => {}, 5000);
console.log("done");`);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "done\n");
    assert.ok(result.ms < 4000, `took ${result.ms}ms`);
  });

  it("an unreachable instance fails with ZEN_BROWSER_UNAVAILABLE and a way forward", async () => {
    const result = await runCli(["nodejs", "-e", 'await taskSpace("x")'], { socketPath: join(mock.dir, "nobody.sock") });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ZEN_BROWSER_UNAVAILABLE.*taskSpace: zenius instance .* is not running.*zenius status/s);
  });

  it("scripts that never touch the browser run without an instance", async () => {
    const result = await runCli(["nodejs", "-e", "console.log(typeof taskSpace)"], { socketPath: join(mock.dir, "nobody.sock") });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "function\n");
  });

  it("usage errors exit 2", async () => {
    for (const args of [["nodejs", "extra"], ["nodejs", "-e"], ["bogus"], ["skill", "x"], ["--instance"]]) {
      const result = await runCli(args, { socketPath: mock.socketPath });
      assert.equal(result.code, 2, `zenius ${args.join(" ")}`);
      assert.match(result.stderr, /Usage:/);
    }
    const empty = await runCli(["nodejs"], { stdin: "  \n", socketPath: mock.socketPath });
    assert.equal(empty.code, 2);
  });
});

describe("other subcommands", () => {
  it("zenius skill prints the guide between the version line and the end marker", async () => {
    const result = await runCli(["skill"]);
    assert.equal(result.code, 0);
    const platform = process.platform === "darwin" ? "macos" : "linux";
    assert.match(result.stdout, new RegExp(String.raw`^\[zenius:skill\] zenius usage guide v\d+\.\d+\.\d+ \(${platform}\)\n`));
    assert.match(result.stdout, /\n\[zenius:skill\] end of guide v\d+\.\d+\.\d+\n$/);
    assert.doesNotMatch(result.stdout, /<!-- platform/);
  });

  it("zenius help lists the API and explains one method", async () => {
    const index = await runCli(["help"]);
    assert.equal(index.code, 0);
    assert.match(index.stdout, /await page\.click\(selector/);
    const one = await runCli(["help", "page.waitForEvent"]);
    assert.equal(one.code, 0);
    assert.match(one.stdout, /^Page\.waitForEvent\n\nWait for this Page's next "popup" or "download"/);
    const unknown = await runCli(["help", "page.locator"]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stdout, "Unknown helper: page.locator\n");
  });

  it("zenius status lists registered instances and probes their sockets", async () => {
    const home = mkdtempSync(join(tmpdir(), "zenius-home-"));
    try {
      mkdirSync(join(home, "instances"));
      writeFileSync(
        join(home, "instances", "mock.json"),
        JSON.stringify({ instance: "mock", pid: process.pid, socket: mock.socketPath, zenVersion: "1.24.2b" }),
      );
      writeFileSync(join(home, "instances", "gone.json"), JSON.stringify({ instance: "gone", pid: 999999999, socket: join(home, "gone.sock") }));
      const result = await runCli(["status", "--instance", "mock"], { env: { ZENIUS_HOME: home } });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^selected instance: mock$/m);
      assert.match(result.stdout, /^\* mock {2}ready {2}pid \d+ {2}zen 1\.24\.2b {2}runtime 0\.0\.0-mock/m);
      assert.match(result.stdout, /^ {2}gone {2}stale \(process gone\)/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the bundle and the TypeScript entry also run when started directly", async () => {
    const { spawnSync } = await import("node:child_process");
    for (const entry of ["../dist/zenius.mjs", "../src/cli.ts"]) {
      const path = fileURLToPath(new URL(entry, import.meta.url));
      const result = spawnSync(process.execPath, [path, "nodejs", "-e", "console.log(typeof taskSpace)"], { encoding: "utf8", env: guardHome({ ...process.env }, "cli.test") });
      assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
      assert.equal(result.stdout, "function\n", entry);
    }
  });

  it("--version and --help", async () => {
    const version = await runCli(["--version"]);
    assert.match(version.stdout, /^zenius \d+\.\d+\.\d+ \(protocol 1\)\n$/);
    const help = await runCli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /zenius nodejs <<'EOF'/);
  });
});

describe("zenius nodejs in the sandbox", () => {
  it("writes a relative path to the working folder, lists it, and can't write the folder it started in", async () => {
    const base = mkdtempSync(join(tmpdir(), "zenius-cli-sbx-"));
    const [out, box, work] = ["zenius-files", "box", "work"].map((name) => join(base, name));
    for (const folder of [out, box, work]) mkdirSync(folder);
    try {
      const repo = fileURLToPath(new URL("../..", import.meta.url));
      const result = await runCli(["nodejs"], {
        socketPath: mock.socketPath,
        env: { ZENIUS_WORKING_DIR: out, TMPDIR: box },
        // The launcher's grants, without the OS sandbox around them.
        nodeArgs: ["--permission", `--allow-fs-read=${repo}`, `--allow-fs-read=${work}`, `--allow-fs-read=${box}`, `--allow-fs-write=${box}`, `--allow-fs-read=${out}`, `--allow-fs-write=${out}`],
        stdin: `
const page = (await taskSpace("sandboxed output")).page("p1");
console.log(await page.screenshot({ path: "shot.png" }));
await page.screenshot({ path: ${JSON.stringify(join(work, "x.png"))} }).catch((error) => console.log(error.code, error.message));
try { process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(join(work, "y.txt"))}, "x"); } catch (error) { console.log(error.code); }
`,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        [
          join(out, "shot.png"),
          `ZEN_PATH_NOT_ALLOWED page.screenshot path: a sandboxed script writes only to the working folder, ${out}, and its temporary folder, never the folder it started in. Pass a relative path, which lands in the working folder.`,
          "ERR_ACCESS_DENIED",
          "[zenius:files]",
          `Wrote ${join(out, "shot.png")}`,
          "",
        ].join("\n"),
      );
      assert.deepEqual(readdirSync(work), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
