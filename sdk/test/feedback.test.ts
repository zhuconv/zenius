// `zenius feedback`: the CLI sends the runtime only the agent's line, cleaned,
// with its own versions, doctor's results and who writes the report, and
// shows the agent only the user's choice. When no card can open, it writes a
// draft of zenius's own data, and a link that carries only a title.
// zenius mcp's report_problem goes the same way, without the draft.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  cleanLine,
  draftText,
  FEEDBACK_USAGE,
  issueLink,
  issueTitle,
  ISSUES_URL,
  MAX_LINE,
  outcomeText,
  readOutcome,
  writeDraft,
  type Facts,
} from "../src/feedback.ts";
import { VERSION } from "../src/version.ts";
import { runCli } from "./helpers.ts";
import { MockError, MockRuntime } from "./mock-runtime.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.md$/;
const ISSUE = "https://github.com/zhuconv/zenius/issues/41";
const TEMPLATE_FILE = join(ROOT, ".github", "ISSUE_TEMPLATE", "zenius-problem.md");
const REPORT = {
  id: "{00000000-0000-4000-8000-000000000001}",
  title: "zenius 0.1.4: ZEN_INTERNAL in page.click",
  body: "From `zenius feedback`.\n\n## What went wrong, in the agent's words\n\n    a line\n",
};
const SIDEBAR_TASK = "0b1c2d3e-0000-4000-8000-00000000000a";
const AFTER_REPORT = "Then finish the task with zenius's other tools if you can; otherwise stop and tell the user what failed.";
const DRAFT_SAYS = "zenius sends nothing. Show the user the file and this link. To file the report, they read the draft, open the link and paste the draft into the form:";

let mock: MockRuntime;
let base: string;
let runtimeCleanLine: (text: string, home?: string) => string;
before(async () => {
  mock = await new MockRuntime().start();
  base = mkdtempSync(join(tmpdir(), "zenius-feedback-"));
  // The runtime's own text module: plain functions, which Node loads too.
  runtimeCleanLine = (await import(pathToFileURL(join(ROOT, "runtime/JS/zenius/modules/feedbacktext.sys.mjs")).href)).cleanLine;
});
after(async () => {
  await mock.stop();
  rmSync(base, { recursive: true, force: true });
});

/** A home of its own for each run, so doctor finds no Zen and a draft lands where the test looks. */
function home(name: string) {
  const dir = join(base, name);
  mkdirSync(dir);
  const zhome = join(dir, ".zenius");
  return { dir, zhome, env: { HOME: dir, ZENIUS_HOME: zhome, XDG_CONFIG_HOME: join(dir, ".config"), ZEN_BIN: "" } };
}

/** A runtime with feedback.*: compose answers REPORT, and propose answers as `answer` does. */
function cardRuntime(answer: () => unknown) {
  mock.handle("feedback.compose", () => REPORT);
  mock.handle("feedback.propose", answer);
}

/** The CLI's three lines for a draft: why and where, what to do, the link. */
function draftOutput(stdout: string, why: string) {
  const [first, second, link, rest] = stdout.split("\n");
  assert.equal(rest, "", "three lines");
  const prefix = `${why}, so zenius feedback wrote the report as a draft: `;
  assert.ok(first!.startsWith(prefix), first);
  assert.equal(second, DRAFT_SAYS);
  return { file: first!.slice(prefix.length), link: new URL(link!) };
}

describe("zenius feedback", () => {
  it("sends the runtime the agent's line, cleaned, and zenius's own facts only, then prints the user's choice", async () => {
    cardRuntime(() => ({ outcome: "posted", number: 41, url: ISSUE, title: "the title as the user edited it" }));
    const { dir, zhome, env } = home("posted");
    const line = `Clicking Pay on https://shop.example/cart?card=4111 failed twice for jane@example.com;\nsaved to ${dir}/receipt.pdf`;
    const from = mock.requests.length;
    const result = await runCli(["feedback", line], { socketPath: mock.socketPath, env: { ...env, ZENIUS_CLIENT: "Test Agent", ZENIUS_SIDEBAR_TASK: SIDEBAR_TASK } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `The user sent the report: issue #41, ${ISSUE}\n`);

    const requests = mock.requests.slice(from);
    assert.deepEqual(requests.slice(-2).map((request) => request.method), ["feedback.compose", "feedback.propose"], "doctor's reads come first");
    const params = requests.at(-2)!.params;
    assert.deepEqual(Object.keys(params).sort(), ["cli", "doctor", "line", "node", "source"]);
    // Who writes it, as a task's source: the runtime keeps it beside the report, for the card.
    assert.equal(params.source.agent, "Test Agent");
    assert.equal(params.source.sidebar, SIDEBAR_TASK);
    for (const key of Object.keys(params.source)) assert.ok(["terminal", "agent", "folder", "sidebar"].includes(key), key);
    assert.equal(params.line, "Clicking Pay on <link> failed twice for <email>; saved to ~/receipt.pdf");
    const { commit, ...cli } = params.cli;
    assert.deepEqual(cli, { version: VERSION, protocol: 1, sandboxed: false });
    if (commit !== undefined) assert.match(commit, /^[0-9a-f]{4,40}(-dirty)?$/);
    assert.equal(params.node, process.versions.node);
    assert.deepEqual(params.doctor[0], { id: "cli", status: "ok" });
    for (const check of params.doctor) assert.deepEqual(Object.keys(check), ["id", "status"]);
    assert.deepEqual(requests.at(-1)!.params, { id: REPORT.id, waitMs: 100_000 });
    assert.throws(() => statSync(join(zhome, "feedback")), { code: "ENOENT" }, "no draft");
  });

  it("waits as long as --wait says, at most ten minutes", async () => {
    cardRuntime(() => ({ outcome: "pending" }));
    const { env } = home("wait");
    const from = mock.requests.length;
    const result = await runCli(["feedback", "--wait", "5", "a page's snapshot is empty"], { socketPath: mock.socketPath, env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${outcomeText({ outcome: "pending" })}\n`);
    assert.equal(mock.requests.slice(from).find((request) => request.method === "feedback.compose")!.params.line, "a page's snapshot is empty");
    assert.deepEqual(mock.requests.slice(from).find((request) => request.method === "feedback.propose")!.params, { id: REPORT.id, waitMs: 5000 });
    for (const bad of [["--wait=601"], ["--wait=-1"], ["--wait=1.5"], ["--wait"]]) {
      const refused = await runCli(["feedback", "a line", ...bad], { socketPath: mock.socketPath, env });
      assert.equal(refused.code, 2, bad.join(" "));
      assert.ok(refused.stderr.startsWith("--wait takes whole seconds, at most 600\n"), refused.stderr);
    }
  });

  it("says when a report already waits, or the user discarded one in the last ten minutes, and writes nothing", async () => {
    const { zhome, env } = home("refused");
    cardRuntime(() => {
      throw new MockError("ZEN_FEEDBACK_PENDING", "another problem report waits");
    });
    const pending = await runCli(["feedback", "a line"], { socketPath: mock.socketPath, env });
    assert.equal(pending.code, 1);
    assert.equal(pending.stdout, "");
    assert.match(pending.stderr, /^zenius feedback: another problem report waits for the user in Zen's agent sidebar\. Don't send another/);
    cardRuntime(() => {
      throw new MockError("ZEN_FEEDBACK_DECLINED", "the user discarded a problem report", { retryAfterMs: 1000 });
    });
    const declined = await runCli(["feedback", "a line"], { socketPath: mock.socketPath, env });
    assert.equal(declined.code, 1);
    assert.match(declined.stderr, /^zenius feedback: the user discarded a problem report less than 10 minutes ago\. Don't send another before then\.\n$/);
    assert.throws(() => statSync(join(zhome, "feedback")), { code: "ENOENT" });
  });

  it("with no sidebar to show it, writes the runtime's report as a draft for the user alone, and a link with its title only", async () => {
    cardRuntime(() => {
      throw new MockError("ZEN_UNSUPPORTED", "no agent sidebar can show the report", { reason: "no_sidebar" });
    });
    const { zhome, env } = home("no-sidebar");
    const result = await runCli(["feedback", "a line"], { socketPath: mock.socketPath, env });
    assert.equal(result.code, 0, result.stderr);
    const { file, link } = draftOutput(result.stdout, "No agent sidebar can show the report");
    assert.equal(file, join(zhome, "feedback", file.split("/").at(-1)!));
    assert.match(file.split("/").at(-1)!, STAMP);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(zhome, "feedback")).mode & 0o777, 0o700);
    const draft = readFileSync(file, "utf8");
    assert.match(draft, /^# zenius feedback\n/);
    assert.ok(draft.endsWith(`\n\n${REPORT.body}`), draft);
    assert.equal(`${link.origin}${link.pathname}`, ISSUES_URL);
    assert.deepEqual([...link.searchParams], [
      ["template", "zenius-problem.md"],
      ["title", REPORT.title],
    ]);
  });

  it("still writes a draft when the instance doesn't answer, and says so", async () => {
    const { zhome, env } = home("closed");
    const result = await runCli(["feedback", "zenius nodejs hangs"], { socketPath: join(zhome, "run", "nothing.sock"), env });
    assert.equal(result.code, 0, result.stderr);
    const { file, link } = draftOutput(result.stdout, "Zen isn't answering");
    const draft = readFileSync(file, "utf8");
    assert.ok(draft.includes("\n- zenius runtime: the instance didn't answer (ZEN_BROWSER_UNAVAILABLE)\n- Zen of an unknown version\n"), draft);
    assert.equal(draft.split("Not known: the instance didn't answer.").length, 3, draft);
    assert.equal(link.searchParams.get("title"), `zenius ${VERSION}: ZEN_BROWSER_UNAVAILABLE`);
  });

  it("writes a draft for a runtime from before zenius feedback's card, with its versions and nothing else of it", async () => {
    mock.handle("feedback.compose", () => {
      throw new MockError("ZEN_UNSUPPORTED", "mock runtime has no method feedback.compose");
    });
    mock.handle("browser.version", () => ({
      zenVersion: "1.24.2b",
      runtimeVersion: "0.1.3",
      updateAvailable: false,
      install: { commit: "0123456789abcdef0123456789abcdef01234567", installedAt: "2026-11-23T20:00:00Z" },
    }));
    const { dir, env } = home("older");
    const line = `Clicking Pay on https://shop.example/cart?card=4111 failed for jane@example.com, see ${dir}/a.pdf`;
    const result = await runCli(["feedback", "--instance", "dev-a", line], { socketPath: mock.socketPath, env });
    assert.equal(result.code, 0, result.stderr);
    const { file, link } = draftOutput(result.stdout, "This Zen's zenius is older than zenius feedback's card");
    const draft = readFileSync(file, "utf8");
    assert.ok(draft.includes("\n    Clicking Pay on <link> failed for <email>, see ~/a.pdf\n"), draft);
    assert.ok(draft.includes(`\n- zenius ${VERSION} (protocol 1)`), draft);
    assert.ok(draft.includes("\n- zenius runtime 0.1.3, installed from commit 0123456\n- Zen 1.24.2b\n"), draft);
    assert.ok(draft.includes(`\n- Node ${process.versions.node}\n`), draft);
    assert.ok(draft.includes("\n- Instance: not the default one\n"), draft);
    assert.equal(draft.split("Not known: this Zen's zenius is older than zenius feedback's card.").length, 3, draft);
    assert.match(draft, /\n## zenius doctor\n\ncli ok, zen (ok|warn|fail|skip), autoconfig /);
    for (const text of ["shop.example", "4111", "jane", dir, "dev-a", "installedAt", "2026-11-23T20"]) {
      assert.ok(!draft.includes(text), `the draft holds ${text}`);
    }
    assert.equal(link.searchParams.get("title"), `zenius ${VERSION}: a problem report`);
  });

  it("in the sandbox, says it's sandboxed, and writes a draft in the run's output folder and nowhere else", async () => {
    cardRuntime(() => {
      throw new MockError("ZEN_UNSUPPORTED", "no agent sidebar can show the report", { reason: "no_sidebar" });
    });
    const { zhome, env } = home("sandboxed");
    const out = join(base, "sandboxed-out");
    mkdirSync(out);
    const from = mock.requests.length;
    const result = await runCli(["feedback", "page.screenshot fails"], {
      socketPath: mock.socketPath,
      env: { ...env, ZENIUS_OUTPUT_DIR: out },
      // The launcher's grants, without the OS sandbox around them.
      nodeArgs: ["--permission", `--allow-fs-read=${ROOT}`, `--allow-fs-read=${mock.socketPath}`, `--allow-fs-read=${out}`, `--allow-fs-write=${out}`],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.requests.slice(from).find((request) => request.method === "feedback.compose")!.params.cli.sandboxed, true);
    const { file } = draftOutput(result.stdout, "No agent sidebar can show the report");
    assert.equal(file, join(out, file.split("/").at(-1)!));
    assert.deepEqual(readdirSync(out).length, 1);
    assert.throws(() => statSync(join(zhome, "feedback")), { code: "ENOENT" });
  });

  it("needs a line, and prints its help", async () => {
    const none = await runCli(["feedback"], { socketPath: mock.socketPath });
    assert.equal(none.code, 2);
    assert.equal(none.stderr, `zenius feedback needs one line saying what you were doing when zenius failed\n\n${FEEDBACK_USAGE}`);
    assert.equal((await runCli(["feedback", " \n\t"], { socketPath: mock.socketPath })).code, 2);
    const help = await runCli(["feedback", "--help"]);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, FEEDBACK_USAGE);
    assert.match((await runCli(["--help"])).stdout, /\n {2}zenius feedback "<one line>" {3}when zenius itself fails: show the user a problem report in the\n {33}sidebar, to send, copy or discard \(zenius feedback --help\)\n/);
  });
});

describe("feedback's parts", () => {
  it("keeps the agent's line to one line, without links, email addresses or the home folder", () => {
    assert.equal(cleanLine("a\nb\r\nc\td\u0000e\u202ef", "/home/u"), "a b c d e f");
    assert.equal(
      cleanLine("on https://a.example/x?q=1 and http://b.example, file:///etc/x data:text/html,<b> www.c.example/y about:blank", "/home/u"),
      "on <link> and <link> <link> <link> <link> <link>",
    );
    assert.equal(cleanLine("mail jane.doe+x@mail.example.com now", "/home/u"), "mail <email> now");
    assert.equal(cleanLine("saved /home/u/Downloads/a.pdf", "/home/u"), "saved ~/Downloads/a.pdf");
    const long = cleanLine("x".repeat(MAX_LINE + 50), "/home/u");
    assert.equal([...long].length, MAX_LINE);
    assert.ok(long.endsWith("..."));
    assert.equal([...cleanLine("é".repeat(MAX_LINE + 1), "/home/u")].length, MAX_LINE, "cut by characters");
  });

  it("reads at most 2,000 characters of a line, as the runtime does: its patterns grow with the square of their input", () => {
    const t0 = performance.now();
    assert.ok(cleanLine("a.".repeat(500_000), "/home/u").length <= MAX_LINE);
    assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
  });

  it("cleans the line as the runtime does", () => {
    for (const text of [
      "a\nb\r\nc\td\u0000e\u202ef",
      "on https://a.example/x?q=1 and http://b.example, file:///etc/x data:text/html,<b> www.c.example/y about:blank",
      "mail jane.doe+x@mail.example.com now, saved /home/u/Downloads/a.pdf",
      "on shop.example.com/orders/123, intranet.example:8443/a?b=c and jane@example.com/x, not page.click, v0.1.4/notes or app.v2/x",
      "x".repeat(MAX_LINE + 50),
      `${"word ".repeat(500)}https://late.example/`,
      "é".repeat(MAX_LINE + 1),
    ]) {
      assert.equal(runtimeCleanLine(text, "/home/u"), cleanLine(text, "/home/u"), text);
    }
    for (const [text, home] of [
      ["cache in /tmp/zt-sdk-unit.AbCdEf/x, ~/Sites/www.example.com/, //cdn.example.com/lib.js and https:/shop.example.com/x", "/home/u"],
      ["saved to /Users/john.smith/Documents/x.pdf, copied to /Volumes/Backup/Users/john.smith/x", "/Users/john.smith"],
      ["in /home/jane@corp.example/x, for jane.doe@corp.example/x", "/home/jane@corp.example"],
      ["see file:/home/jane/x, (/home/jane) and files.example.com/home/jane/x", "/home/jane"],
    ]) {
      assert.equal(runtimeCleanLine(text, home), cleanLine(text, home), text);
    }
  });

  it("shows the agent only the outcome, and an issue's number and address in zenius's repository", () => {
    assert.deepEqual(readOutcome({ outcome: "posted", number: 41, url: ISSUE, title: "an edited title", body: "an edited body" }), {
      outcome: "posted",
      number: 41,
      url: ISSUE,
    });
    assert.deepEqual(readOutcome({ outcome: "commented", number: 41, url: `${ISSUE}#issuecomment-99` }), {
      outcome: "commented",
      number: 41,
      url: `${ISSUE}#issuecomment-99`,
    });
    for (const url of ["https://github.com/someone/else/issues/41", "https://evil.example/x", `${ISSUE}\nmore`]) {
      assert.deepEqual(readOutcome({ outcome: "posted", number: 41, url }), { outcome: "pending" }, url);
    }
    assert.deepEqual(readOutcome({ outcome: "copied", url: ISSUE, error: "gh said this" }), { outcome: "copied" });
    assert.deepEqual(readOutcome({ outcome: "<b>pwned</b>" }), { outcome: "pending" });
    assert.deepEqual(readOutcome(null), { outcome: "pending" });
    assert.equal(outcomeText({ outcome: "discarded" }), "The user discarded the report. Don't send another for now.");
  });

  it("writes a second draft in the same second beside the first", () => {
    const dir = join(base, "twice");
    const at = new Date("2026-11-23T21:15:04.250Z");
    assert.equal(writeDraft(dir, "one", at), join(dir, "2026-11-23T21-15-04Z.md"));
    assert.equal(writeDraft(dir, "two", at), join(dir, "2026-11-23T21-15-04Z-2.md"));
    assert.equal(readFileSync(join(dir, "2026-11-23T21-15-04Z.md"), "utf8"), "one");
  });

  const facts: Facts = {
    cli: { version: "9.9.9", protocol: 1, commit: "abcdef0", sandboxed: false },
    node: "24.0.0",
    os: { platform: "darwin", release: "25.1.0", arch: "arm64" },
    defaultInstance: true,
    runtime: { zen: "1.24.2b", version: "9.9.9" },
    doctor: [{ id: "cli", status: "ok" }],
  };

  it("puts nothing of the draft in the link", () => {
    const draft = draftText("what the agent wrote", facts);
    assert.ok(draft.includes("\n    what the agent wrote\n"), draft);
    const link = new URL(issueLink(issueTitle(facts)));
    assert.deepEqual([...link.searchParams], [
      ["template", "zenius-problem.md"],
      ["title", "zenius 9.9.9: a problem report"],
    ]);
    for (const text of ["what the agent wrote", "darwin", "abcdef0", "24.0.0", "cli ok"]) {
      assert.ok(!decodeURIComponent(link.href).includes(text), text);
    }
  });

  it("writes the issue template's sections, in its order", () => {
    const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));
    const template = headings(readFileSync(TEMPLATE_FILE, "utf8"));
    assert.ok(template.length >= 5, "the template's sections");
    assert.deepEqual(headings(draftText("x", facts)), template);
  });
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** zenius mcp on the mock runtime, as Claude Code: initialize, then each tool call in turn, and each one's result. */
async function mcpCalls(calls: Array<[string, Record<string, unknown>]>, env: Record<string, string>): Promise<ToolResult[]> {
  const messages = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } },
    ...calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } })),
  ];
  const run = await runCli(["mcp"], {
    stdin: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    socketPath: mock.socketPath,
    env: { ZENIUS_CLIENT: "", ...env },
  });
  assert.equal(run.code, 0, run.stderr);
  const replies = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: number; result: ToolResult });
  return calls.map((_, i) => replies.find((reply) => reply.id === i + 1)!.result);
}

describe("zenius mcp's report_problem", () => {
  it("shows the CLI's report, with who wrote it, and gives the agent only the user's choice and what comes next", async () => {
    cardRuntime(() => ({ outcome: "posted", number: 41, url: ISSUE }));
    const { dir, zhome, env } = home("mcp-posted");
    const from = mock.requests.length;
    const [result] = await mcpCalls([["report_problem", { line: `Clicking Pay on https://shop.example/cart failed twice for jane@example.com\nin ${dir}/x` }]], {
      ...env,
      ZENIUS_SIDEBAR_TASK: SIDEBAR_TASK,
    });
    assert.ok(!result!.isError, result!.content[0]!.text);
    const [step, text, next, rest] = result!.content[0]!.text.split("\n");
    assert.equal(step, 'Report a problem with zenius: "Clicking Pay on <link> failed twice for <email> in ~/x"', "the user sees the line as the report keeps it");
    assert.equal(text, `The user sent the report: issue #41, ${ISSUE}`);
    assert.equal(next, AFTER_REPORT);
    assert.equal(rest, undefined);

    const requests = mock.requests.slice(from);
    assert.deepEqual(requests.slice(-2).map((request) => request.method), ["feedback.compose", "feedback.propose"], "doctor's reads come first");
    const params = requests.at(-2)!.params;
    assert.deepEqual(Object.keys(params).sort(), ["cli", "doctor", "line", "node", "source"]);
    assert.equal(params.line, "Clicking Pay on <link> failed twice for <email> in ~/x");
    assert.deepEqual({ version: params.cli.version, protocol: params.cli.protocol, sandboxed: params.cli.sandboxed }, { version: VERSION, protocol: 1, sandboxed: false });
    assert.equal(params.node, process.versions.node);
    assert.deepEqual(params.doctor[0], { id: "cli", status: "ok" });
    assert.equal(params.source.agent, "Claude Code", "the client's name, as its tasks get it");
    assert.equal(params.source.sidebar, SIDEBAR_TASK);
    const proposal = requests.at(-1)!.params;
    assert.equal(proposal.id, REPORT.id);
    // By default the call answers within 50 s of its start, inside Codex's 60 s (mcp.test.ts has the sums).
    assert.ok(Number.isInteger(proposal.waitMs / 1000) && proposal.waitMs >= 10_000 && proposal.waitMs <= 50_000, String(proposal.waitMs));
    assert.throws(() => statSync(join(zhome, "feedback")), { code: "ENOENT" }, "no draft");
  });

  it("waits as long as wait says, at most ten minutes", async () => {
    cardRuntime(() => ({ outcome: "pending" }));
    const { env } = home("mcp-wait");
    const from = mock.requests.length;
    const [short, long] = await mcpCalls(
      [
        ["report_problem", { line: "a page's snapshot is empty", wait: 5 }],
        ["report_problem", { line: "a page's snapshot is empty", wait: 3600 }],
      ],
      env,
    );
    assert.deepEqual(short!.content[0]!.text.split("\n").slice(1), [outcomeText({ outcome: "pending" }), AFTER_REPORT]);
    assert.ok(!long!.isError);
    const proposals = mock.requests.slice(from).filter((request) => request.method === "feedback.propose");
    assert.deepEqual(proposals.map((request) => request.params.waitMs), [5000, 600_000]);
  });

  it("another waiting report, a recent discard, no sidebar and an older runtime are plain answers, and nothing is written", async () => {
    const { zhome, env } = home("mcp-refused");
    const cases: Array<[string, () => void, string]> = [
      [
        "another waits",
        () => cardRuntime(() => {
          throw new MockError("ZEN_FEEDBACK_PENDING", "another problem report waits");
        }),
        "Another problem report already waits for the user in Zen's agent sidebar, so this one wasn't shown. Don't send another: tell the user it's there.",
      ],
      [
        "a recent discard",
        () => cardRuntime(() => {
          throw new MockError("ZEN_FEEDBACK_DECLINED", "the user discarded a problem report", { retryAfterMs: 1000 });
        }),
        "The user discarded a problem report less than 10 minutes ago, so this one wasn't shown. Don't send another before then.",
      ],
      [
        "no sidebar",
        () => cardRuntime(() => {
          throw new MockError("ZEN_UNSUPPORTED", "no agent sidebar can show the report", { reason: "no_sidebar" });
        }),
        "Zen has no agent sidebar to show the report in, so nothing was shown, saved or sent.",
      ],
      [
        "an older runtime",
        () =>
          mock.handle("feedback.compose", () => {
            throw new MockError("ZEN_UNSUPPORTED", "mock runtime has no method feedback.compose");
          }),
        "This Zen's zenius is older than problem reports, so nothing was shown, saved or sent.",
      ],
    ];
    for (const [what, runtime, says] of cases) {
      runtime();
      const [result] = await mcpCalls([["report_problem", { line: "page.click failed twice with ZEN_INTERNAL" }]], env);
      assert.ok(!result!.isError, `${what}: final, not a failure to retry`);
      assert.deepEqual(result!.content[0]!.text.split("\n").slice(1), [says, AFTER_REPORT], what);
    }
    assert.throws(() => statSync(join(zhome, "feedback")), { code: "ENOENT" }, "no draft");
  });

  it("an empty line is the call's mistake, and Zen not answering fails as any call does", async () => {
    cardRuntime(() => ({ outcome: "pending" }));
    const { dir, env } = home("mcp-failed");
    const [empty] = await mcpCalls([["report_problem", { line: " \u200b " }]], env);
    assert.ok(empty!.isError);
    assert.equal(empty!.content[0]!.text, 'Report a problem with zenius: "" failed.\nline must say, in one line, what you were doing when zenius failed');
    const [gone] = await mcpCalls([["report_problem", { line: "every call times out" }]], { ...env, ZENIUS_SOCKET: join(dir, "no.sock") });
    assert.ok(gone!.isError);
    assert.match(gone!.content[0]!.text, /^Report a problem with zenius: "every call times out" failed\.\nZEN_BROWSER_UNAVAILABLE: /);
  });
});
