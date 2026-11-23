// `zenius selfcheck`, the post-install self-check's front (src/selfcheck.ts,
// docs/research/selfcheck.md): the socket it reaches and the one it never
// does, the wait for Zen to be in the background, what it prints, and its
// exit codes. That the sandbox can't reach the self-check's socket is
// tests/security/sandbox.test.mjs's canary.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { ZeniusError } from "../src/errors.ts";
import { failureText, formatResult, runSelfcheck, SELFCHECK_USAGE, type SelfcheckCheck, waitText } from "../src/selfcheck.ts";
import { runCli } from "./helpers.ts";
import { MockError, MockRuntime } from "./mock-runtime.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

let home: string;
/** The agents' socket, which ZENIUS_SOCKET names in every run: the self-check never goes there. */
let agents: MockRuntime;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "zsc-"));
  mkdirSync(join(home, "selfcheck"), { mode: 0o700 });
  agents = await new MockRuntime().start();
});
after(async () => {
  await agents.stop();
  rmSync(home, { recursive: true, force: true });
});

const runDir = (instance = "default") => join(home, "selfcheck", instance, "20261122T231500Z");
/** A path as the CLI shows it: under the home folder, with ~. */
const shown = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

type Answer = { ok: boolean; timedOut: boolean; ms: number; dir: string; runtimeVersion: string; commit: string; zenVersion: string; checks: SelfcheckCheck[] };

function passing(dir = runDir()): Answer {
  return {
    ok: true,
    timedOut: false,
    ms: 41234,
    dir,
    runtimeVersion: "0.1.0",
    commit: "07419aa",
    zenVersion: "1.24.2b",
    checks: [
      { id: "menu", title: "The ⋯ menu", ok: true, failedStep: null, error: null, shots: ["1-menu-chat.png", "2-menu-work.png"] },
      { id: "archive", title: "Archive, Archived and Unarchive", ok: true, failedStep: null, error: null, shots: ["3-archive-tooltip.png"] },
      { id: "follow", title: "Sending follows the answer", ok: true, failedStep: null, error: null, shots: ["4-follow-sent.png"] },
    ],
  };
}

type Handler = Parameters<MockRuntime["handle"]>[1];

/** A self-check socket at its place in the test's ZENIUS_HOME, answering selfcheck.run with `answer`. */
async function withSelfcheck(instance: string, answer: Handler, body: (mock: MockRuntime) => Promise<void>) {
  const mock = new MockRuntime({ socketPath: join(home, "selfcheck", `${instance}.sock`) });
  mock.handle("selfcheck.run", answer);
  await mock.start();
  try {
    await body(mock);
  } finally {
    await mock.stop();
    rmSync(mock.socketPath, { force: true });
  }
}

/** The command as the user's shell runs it, with ZENIUS_SOCKET naming the agents' socket. */
const selfcheck = (args: string[] = [], env: Record<string, string> = {}) =>
  runCli(["selfcheck", ...args], { socketPath: agents.socketPath, env: { ZENIUS_HOME: home, ...env }, timeoutMs: 30_000 });

/** Anything an agent could run: a command, a path into the CLI, a quoted snippet. */
const COMMAND = /`|\bnode\b|PATH=|bin\/zenius|zenius\/cli|install-cli/;

describe("zenius selfcheck", () => {
  it("calls selfcheck.run with no params on <ZENIUS_HOME>/selfcheck/<instance>.sock, never on ZENIUS_SOCKET, and prints a line per check and the folder", async () => {
    await withSelfcheck("default", () => passing(), async (mock) => {
      const before = agents.requests.length;
      const result = await selfcheck();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(
        mock.requests.map((request) => [request.method, request.params]),
        [["selfcheck.run", {}]],
      );
      assert.equal(agents.requests.length, before, "the agents' socket got a request");
      assert.equal(
        result.stdout,
        'zenius selfcheck, instance "default": runtime 0.1.0 at 07419aa, Zen 1.24.2b\n\n' +
          "ok    The ⋯ menu\nok    Archive, Archived and Unarchive\nok    Sending follows the answer\n\n" +
          `All 3 checks passed in 41.2 s.\nThe shots and summary.json are in ${shown(runDir())}\n`,
      );
    });
  });

  it("takes the instance from --instance, else ZENIUS_INSTANCE", async () => {
    await withSelfcheck("zs-2", () => passing(runDir("zs-2")), async (mock) => {
      const flagged = await selfcheck(["--instance", "zs-2"]);
      assert.equal(flagged.code, 0, flagged.stderr);
      assert.match(flagged.stdout, /^zenius selfcheck, instance "zs-2": /);
      const fromEnv = await selfcheck([], { ZENIUS_INSTANCE: "zs-2" });
      assert.equal(fromEnv.code, 0, fromEnv.stderr);
      assert.equal(mock.requests.length, 2);
    });
  });

  it("exits 1 when a check fails, with its step and error on its line, cleaned of what could act on the terminal", async () => {
    const answer = passing();
    answer.ok = false;
    Object.assign(answer.checks[1]!, {
      title: "Archive, Archived\u001b[31m and Unarchive",
      ok: false,
      failedStep: "archive/unarchive",
      error: "the box didn't come back:\n\u202Egot none",
    });
    await withSelfcheck("default", () => answer, async () => {
      const result = await selfcheck();
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr, "");
      const lines = result.stdout.split("\n");
      assert.equal(lines[3], "FAIL  Archive, Archived[31m and Unarchive  at archive/unarchive: the box didn't come back: got none");
      assert.equal(lines[6], "1 of 3 checks failed in 41.2 s.");
      assert.doesNotMatch(result.stdout, /[\u0000-\u0008\u000b-\u001f\u007f\u202E]/);
    });
  });

  it("exits 1 when the run stopped at its time limit or its caller left, and 2 when no check ran", async () => {
    const stopped = { ...passing(), ok: false, timedOut: true, ms: 120_400 };
    stopped.checks = [{ ...stopped.checks[0]!, ok: false, failedStep: "menu/work", error: "the run stopped at its time limit" }, stopped.checks[1]!];
    let { text, code } = formatResult(stopped, "default");
    assert.equal(code, 1);
    assert.match(text, /\n1 of 2 checks failed in 120\.4 s: the run stopped at its time limit\.\n/);
    ({ text, code } = formatResult({ ...passing(), checks: [], ok: false, timedOut: true, ms: 120_100 }, "default"));
    assert.equal(code, 2);
    assert.match(text, /\nThe self-check ran no check in 120\.1 s: the run stopped at its time limit\.\n/);
    // A run whose caller left says so, not that it timed out, even with timedOut set too.
    ({ text, code } = formatResult({ ...stopped, timedOut: true, callerLeft: true, ms: 30_000 }, "default"));
    assert.equal(code, 1);
    assert.match(text, /\n1 of 2 checks failed in 30\.0 s: the caller left\.\n/);
    assert.doesNotMatch(text, /checks failed[^\n]*time limit/);
    ({ text, code } = formatResult({ ...passing(), ok: false, callerLeft: true }, "default"));
    assert.equal(code, 1);
    assert.match(text, /\nEvery check passed in 41\.2 s, but the caller left\.\n/);
    // An answer with no checks at all passes nothing, whatever its ok says.
    assert.equal(formatResult({ ok: true }, "default").code, 2);
  });

  it("names the run's own error, a failure outside the checks, on its summary line, cleaned", async () => {
    // zen-observe's stand-in: the window didn't open, so no check ran.
    let { text, code } = formatResult({ ok: false, error: "Error: the window didn't open", checks: [] }, "default");
    assert.equal(code, 2);
    assert.match(text, /\nThe self-check ran no check: the run failed \(Error: the window didn't open\)\.\n/);
    ({ text, code } = formatResult({ ...passing(), ok: false, error: "Error: cleanup threw\n\u202E  at x" }, "default"));
    assert.equal(code, 1);
    assert.match(text, /\nEvery check passed in 41\.2 s, but the run failed \(Error: cleanup threw at x\)\.\n/);
    // With the time limit too, and beside failed checks.
    ({ text, code } = formatResult({ ...passing(), ok: false, timedOut: true, error: "Error: late", checks: [{ id: "menu", ok: false }] }, "default"));
    assert.equal(code, 1);
    assert.match(text, /\n1 of 1 checks failed in 41\.2 s: the run stopped at its time limit; the run failed \(Error: late\)\.\n/);
    // An error makes no pass, whatever ok says.
    assert.equal(formatResult({ ...passing(), error: "Error: late" }, "default").code, 1);
    // Through the command, as the relay sees it.
    await withSelfcheck("default", () => ({ ok: false, timedOut: false, ms: 1500, error: "Error: the window didn't open", checks: [] }), async () => {
      const result = await selfcheck();
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stdout, /\nThe self-check ran no check in 1\.5 s: the run failed \(Error: the window didn't open\)\.\n$/);
    });
  });

  it("exits 2 when nothing answers, saying where it looked and naming no command", async () => {
    const before = agents.requests.length;
    const result = await selfcheck(["--instance", "nobody"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `zenius selfcheck: nothing answers on ${shown(join(home, "selfcheck", "nobody.sock"))} (ENOENT). ` +
        'The self-check needs Zen running instance "nobody" with a runtime that has it, which opens that socket shortly after Zen starts.\n',
    );
    assert.doesNotMatch(result.stderr, COMMAND);
    assert.equal(agents.requests.length, before, "it fell back to the agents' socket");
  });

  it("says, in the sandbox, that the self-check runs only from the user's own shell, and names no command and no path", () => {
    const socket = join(home, "selfcheck", "default.sock");
    const blocked = (errno: string) => new ZeniusError("ZEN_BROWSER_UNAVAILABLE", "selfcheck.run: refused", { socket, errno });
    const expected =
      "this process can't reach the self-check (ENOENT). " +
      "The self-check runs only from the user's own shell, outside zenius's sandbox (install-daily.md, step 6).";
    // bwrap leaves the socket out of the mount namespace; sandbox-exec refuses the connect.
    assert.equal(failureText(blocked("ENOENT"), socket, "default", { sandboxed: true }), expected);
    assert.equal(failureText(blocked("EPERM"), socket, "default", { sandboxed: true }), expected.replace("ENOENT", "EPERM"));
    // Another sandbox around a shell (Codex's, with its network off) refuses it the same way.
    assert.equal(failureText(blocked("EPERM"), socket, "default", { sandboxed: false }), expected.replace("ENOENT", "EPERM"));
    // No path either: it would show an agent whose harness reaches Unix sockets what to try (zen-observe's review).
    for (const errno of ["ENOENT", "EPERM", "EACCES", "ECONNREFUSED"]) {
      const text = failureText(blocked(errno), socket, "default", { sandboxed: true });
      assert.doesNotMatch(text, COMMAND);
      assert.doesNotMatch(text, /selfcheck\/|\.sock|\//, text);
    }
  });

  it("exits 2 with the runtime's word when a run is going or the self-check can't run", async () => {
    await withSelfcheck("default", () => {
      throw new MockError("ZEN_SELFCHECK_BUSY", "a self-check is running");
    }, async () => {
      const result = await selfcheck();
      assert.equal(result.code, 2);
      assert.equal(result.stderr, 'zenius selfcheck: a self-check is already running in instance "default". Wait for it to end.\n');
    });
    await withSelfcheck("default", () => {
      throw new MockError("ZEN_SELFCHECK_UNAVAILABLE", "the agent sidebar isn't loaded");
    }, async () => {
      const result = await selfcheck();
      assert.equal(result.code, 2);
      assert.equal(result.stderr, "zenius selfcheck: the agent sidebar isn't loaded (ZEN_SELFCHECK_UNAVAILABLE)\n");
    });
  });

  it("closes the connection when its limit passes, which is what stops the run", async () => {
    let closed: (() => void) | undefined;
    const left = new Promise<void>((resolve) => (closed = resolve));
    const socket = join(home, "selfcheck", "slow.sock");
    const mock = new MockRuntime({ socketPath: socket });
    mock.handle("selfcheck.run", (_params, context) => {
      context.socket.once("close", () => closed!());
      return new Promise(() => {});
    });
    await mock.start();
    try {
      const started = performance.now();
      const outcome = await runSelfcheck(socket, "slow", { timeoutMs: 1000 });
      assert.ok("error" in outcome);
      assert.equal(outcome.error.code, "ZEN_TIMEOUT");
      await left;
      assert.ok(performance.now() - started < 5000);
      assert.equal(
        failureText(outcome.error, socket, "slow", { sandboxed: false, timeoutMs: 1000 }),
        "no answer in 1 s. Closing the connection stopped the run, and the runtime cleans up after it.",
      );
    } finally {
      await mock.stop();
      rmSync(socket, { force: true });
    }
  });

  it("says once, on stderr, that it waits while the runtime holds the run for Zen to be in the background, and the summary gives the wait", async () => {
    const answer = { ...passing(), ms: 53_579, waitedMs: 12_345 };
    await withSelfcheck("default", (_params, context) => {
      // As the runtime: held frames go only to a caller that asked for progress.
      if (context.frame.progress !== true) return { ...answer, waitedMs: 0 };
      context.progress({ held: true, reason: "zen-in-front" });
      return new Promise((resolve) =>
        setTimeout(() => {
          context.progress({ held: false });
          resolve(answer);
        }, 300),
      );
    }, async () => {
      const result = await selfcheck();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "zenius selfcheck: waiting for Zen to be in the background (up to 60 s)\n");
      // The runtime's ms counts the wait; the summary's time is the run's own.
      assert.ok(
        result.stdout.includes(
          "ok    Sending follows the answer\n\nIt waited 12.3 s for Zen to be in the background.\nAll 3 checks passed in 41.2 s.\nThe shots and summary.json are in ",
        ),
        result.stdout,
      );
    });
  });

  it("exits 2 when Zen stayed in front for the whole wait, so nothing ran", async () => {
    const inFront = "Zen stayed in front for 60 s, and the self-check opens its window only while Zen is in the background";
    await withSelfcheck("default", (_params, context) => {
      context.progress({ held: true, reason: "zen-in-front" });
      context.progress({ held: false });
      return { ...passing(), ok: false, ms: 60_231, waitedMs: 60_200, error: inFront, checks: [] };
    }, async () => {
      const result = await selfcheck();
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stderr, "zenius selfcheck: waiting for Zen to be in the background (up to 60 s)\n");
      assert.ok(
        result.stdout.includes(`\n\nIt waited 60.2 s for Zen to be in the background.\nThe self-check ran no check: the run failed (${inFront}).\n`),
        result.stdout,
      );
    });
  });

  it("pauses its limit while the runtime holds the run, and tells its caller once", async () => {
    const socket = join(home, "selfcheck", "held.sock");
    const mock = new MockRuntime({ socketPath: socket });
    mock.handle("selfcheck.run", (_params, context) => {
      context.progress({ held: true, reason: "zen-in-front" });
      return new Promise((resolve) => {
        setTimeout(() => {
          context.progress({ held: false });
          context.progress({ held: true, reason: "zen-in-front" });
        }, 700);
        setTimeout(() => {
          context.progress({ held: false });
          resolve({ ...passing(), waitedMs: 1400 });
        }, 1400);
      });
    });
    await mock.start();
    try {
      const told: (string | undefined)[] = [];
      // A limit well under the hold: only a paused limit lets the answer through.
      const outcome = await runSelfcheck(socket, "held", { timeoutMs: 500, onWait: (reason) => told.push(reason) });
      assert.ok("result" in outcome, "error" in outcome ? outcome.error.message : "");
      assert.equal(outcome.result.waitedMs, 1400);
      assert.deepEqual(told, ["zen-in-front"]);
    } finally {
      await mock.stop();
      rmSync(socket, { force: true });
    }
  });

  it("stops waiting when the runtime holds the run past the front's own limit, by closing the connection", async () => {
    let closed: (() => void) | undefined;
    const left = new Promise<void>((resolve) => (closed = resolve));
    const socket = join(home, "selfcheck", "stuck.sock");
    const mock = new MockRuntime({ socketPath: socket });
    mock.handle("selfcheck.run", (_params, context) => {
      context.socket.once("close", () => closed!());
      context.progress({ held: true, reason: "zen-in-front" });
      return new Promise(() => {});
    });
    await mock.start();
    try {
      const started = performance.now();
      const outcome = await runSelfcheck(socket, "stuck", { timeoutMs: 60_000, holdLimitMs: 1000 });
      assert.ok("error" in outcome);
      assert.equal(outcome.error.code, "ZEN_TIMEOUT");
      assert.equal(outcome.error.data?.reason, "held");
      await left;
      const ms = performance.now() - started;
      assert.ok(ms >= 900 && ms < 5000, `${ms} ms`);
      const options = { sandboxed: false, holdLimitMs: 1000 };
      assert.equal(
        failureText(outcome.error, socket, "stuck", options),
        "still held after 1 s, waiting for Zen to be in the background, though the runtime waits at most 60 s. " +
          "Closing the connection stopped the run, and the runtime cleans up after it.",
      );
      // Another reason, cleaned, or none.
      const held = (heldFor?: string) => new ZeniusError("ZEN_TIMEOUT", "held", { socket, reason: "held", ...(heldFor === undefined ? {} : { heldFor }) });
      assert.equal(
        failureText(held("pa\u202Eused"), socket, "stuck", options),
        "still held after 1 s (paused). Closing the connection stopped the run, and the runtime cleans up after it.",
      );
      assert.equal(failureText(held(), socket, "stuck", options), "still held after 1 s. Closing the connection stopped the run, and the runtime cleans up after it.");
    } finally {
      await mock.stop();
      rmSync(socket, { force: true });
    }
  });

  it("words the wait by the runtime's reason, cleaned", () => {
    assert.equal(waitText("zen-in-front"), "waiting for Zen to be in the background (up to 60 s)");
    assert.equal(waitText("pa\u202Eused\n"), "waiting (paused)");
    assert.equal(waitText(undefined), "waiting");
  });

  it("refuses an instance name that could leave selfcheck/, and arguments it doesn't take", async () => {
    for (const [args, env] of [
      [["--instance", "../run/default"], {}],
      [[], { ZENIUS_INSTANCE: "a/b" }],
    ] as const) {
      const result = await selfcheck([...args], env);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /^zenius selfcheck: an instance name has only letters, digits, '\.', '_' and '-': "/);
    }
    const extra = await selfcheck(["now"]);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /^zenius selfcheck: unexpected argument: now\n\nUsage: zenius selfcheck \[--instance <name>\]/);
  });

  it("has its own --help, and stays out of zenius --help, zenius help, the Skill and the agents' guide", async () => {
    const usage = await selfcheck(["--help"]);
    assert.equal(usage.code, 0);
    assert.equal(usage.stdout, SELFCHECK_USAGE);
    for (const args of [["--help"], ["help"], ["help", "errors"], ["skill"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /self-?check/i, `zenius ${args.join(" ")}`);
    }
    // Its error codes have no help of their own either: help knows them no more than any other name.
    for (const code of ["ZEN_SELFCHECK_BUSY", "ZEN_SELFCHECK_UNAVAILABLE"]) {
      const result = await runCli(["help", code]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stdout, /^Unknown helper: /, code);
      assert.doesNotMatch(result.stdout, /self-check|one runs at a time/i, code);
    }
    const skill = join(REPO, "skill");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
    for (const file of files(skill)) assert.doesNotMatch(readFileSync(file, "utf8"), /self-?check/i, file);
  });
});
