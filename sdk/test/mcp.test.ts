// zenius mcp's steps (zen-core's src/mcp.ts), as a call's arguments give
// them: the lines the user reads in the sidebar, and what a failure shows.
// They must never show a typed secret, a URL's token, or text that reads as
// something else. test/integration/mcp.it.ts drives the
// server against a dev Zen.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { guardHome } from "../../tests/lib/scratch-home.mjs";
import { ZeniusError } from "../src/errors.ts";
import { settleWithin } from "../src/feedback.ts";
import { callTool, reportWaitS, Session, stepFor, toolList } from "../src/mcp.ts";
import { insideFolder } from "../src/mcp-script.ts";
import { CLI } from "./helpers.ts";
import { hookedNotice } from "../src/page.ts";
import { Hooked, MockError, MockRuntime } from "./mock-runtime.ts";

describe("zenius mcp steps", () => {
  it("name the kind of a secret field and never show what was typed into it", () => {
    const typed = (element: string, target = "#field", text = "hunter2") => stepFor("fill", { element, target, text });
    assert.equal(typed("Password"), 'Type a password into "Password"');
    assert.equal(typed("Login", "#login_pw"), 'Type a password into "Login"');
    assert.equal(typed("Field", 'input[name="newPassword"]'), 'Type a password into "Field"');
    assert.equal(typed("Card number"), 'Type a card number into "Card number"');
    assert.equal(typed("Number", 'input[name="cc_number"]'), 'Type a card number into "Number"');
    assert.equal(typed("CVC"), 'Type a security code into "CVC"');
    assert.equal(typed("Expiry (MM/YY)"), "Type a card's expiry date into \"Expiry (MM/YY)\"");
    assert.equal(typed("One-time code"), 'Type a code into "One-time code"');
    assert.equal(typed("Code", "[autocomplete=one-time-code]"), 'Type a code into "Code"');
    assert.equal(typed("PIN"), 'Type a PIN into "PIN"');
    for (const element of ["Name", "Passport number", "Promo code", "Zip code", "Spinach"]) {
      assert.equal(typed(element, "#field", "Ada"), `Type "Ada" into "${element}"`);
    }
    // A ref's field is checked after the fill: when a fill fails, nothing checked it.
    assert.equal(typed("Name", "ref=7", "Ada"), 'Type into "Name"');
    assert.equal(typed("Name", "#name", ""), 'Clear "Name"');
  });

  it("drop the characters that change how a line reads without showing", () => {
    // An RLO reverses what follows it; zero-width and bidi marks hide in copied text.
    assert.equal(stepFor("click", { element: "Pay\u202E\u2066 now\u2069\u200B\u200F\uFEFF", target: "#pay" }), 'Click "Pay now"');
    assert.equal(stepFor("click", { element: "Sign\n\tin", target: "#a" }), 'Click "Sign in"');
    assert.equal(stepFor("wait", { text: "Order\u061C placed\u00AD" }), 'Wait for "Order placed"');
  });

  it("show a URL's host, in punycode, and its path, without the query or fragment", () => {
    assert.equal(stepFor("open", { url: "https://user:pw@shop.example.com/checkout?token=abc#frag" }), "Open shop.example.com/checkout");
    // A Cyrillic а: the step can't pass it off as apple.com.
    assert.equal(stepFor("open", { url: "https://аpple.com/" }), "Open xn--pple-43d.com");
    assert.equal(stepFor("goto", { url: "example.com/a%20b/%E2%80%AE" }), "Go to example.com/a b/");
    assert.equal(stepFor("goto", { url: "http://127.0.0.1:8080/" }), "Go to 127.0.0.1:8080");
    assert.equal(stepFor("open", { url: "file:///etc/passwd" }), "Open file:///etc/passwd");
    const long = stepFor("open", { url: `https://example.com/${"a".repeat(200)}` });
    assert.equal(Array.from(long.slice("Open ".length)).length, 80);
    assert.ok(long.endsWith("…"));
    assert.equal(stepFor("wait", { url: "https://login.example.com/done?code=secret" }), "Wait for the tab to reach login.example.com/done");
  });

  it("read as the user would say them", () => {
    assert.equal(stepFor("wait", { seconds: 1 }), "Wait 1 second");
    assert.equal(stepFor("wait", { seconds: 2 }), "Wait 2 seconds");
    // Codex gives a call 60 s unless told more: no wait goes past 50 s unless asked.
    assert.equal(stepFor("wait", { seconds: 500 }), "Wait 50 seconds");
    assert.equal(stepFor("wait", {}), "Wait 10 seconds");
    assert.equal(stepFor("wait", { user: true }), "Wait for the user to resume the agent");
    assert.equal(stepFor("wait", { downloads: true }), "Wait for the downloads to finish");
    assert.equal(stepFor("read_page", { root: "ref=12" }), "Read part of the page");
    assert.equal(stepFor("read_page", {}), "Read the page");
    assert.equal(stepFor("read_page", { full: true }), "Read the whole page");
    const message = `Log in, then press Resume agent\u202E. ${"x".repeat(100)}`;
    const asked = stepFor("hand_off", { message });
    assert.match(asked, /^Ask the user: "Log in, then press Resume agent\. x+…"$/);
    assert.equal(Array.from(asked.slice('Ask the user: "'.length, -1)).length, 80);
    assert.equal(stepFor("finish", { keep: ["p1"] }), "Finish, keeping 1 tab");
    assert.equal(stepFor("finish", { keep: ["p1", "p2"] }), "Finish, keeping 2 tabs");
    assert.equal(stepFor("finish", { keep: "all" }), "Finish, keeping every tab");
    assert.equal(stepFor("finish", { keep: "none" }), "Finish, closing the task's tabs");
  });

  it("name keys as the user's keyboard does: Cmd and Option on a Mac", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      assert.equal(stepFor("press", { key: "Meta+A" }), "Press Cmd+A");
      assert.equal(stepFor("press", { key: "Alt+ArrowLeft", element: "Search", target: "#q" }), 'Press Option+ArrowLeft on "Search"');
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      assert.equal(stepFor("press", { key: "Meta+A" }), "Press Meta+A");
      assert.equal(stepFor("press", { key: "ControlOrMeta+A" }), "Press Control+A");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("zenius mcp report_problem", () => {
  it("shows the user the line as the report keeps it: no links, email addresses or home folder", () => {
    const home = process.env.HOME ?? "/home/someone";
    assert.equal(
      stepFor("report_problem", { line: `Clicking https://shop.example/cart?card=4111 failed for jane@example.com in ${home}/x\u202e` }),
      'Report a problem with zenius: "Clicking <link> failed for <email> in ~/x"',
    );
    assert.equal(stepFor("report_problem", {}), 'Report a problem with zenius: ""');
  });

  it("answers within 50 s of its start unless the agent asks for longer, with at least 10 s for the user", () => {
    assert.equal(reportWaitS(undefined, 0), 50);
    assert.equal(reportWaitS(undefined, 1500), 48, "doctor's 1.5 s come off the user's wait");
    assert.equal(reportWaitS(undefined, 15_000 + 400), 34, "doctor's 15 s at most, and composing");
    assert.equal(reportWaitS(undefined, 45_000), 10);
    assert.equal(reportWaitS(30, 45_000), 30, "the agent's own wait, as asked");
  });

  it("leaves doctor's checks out when doctor takes longer than its time", async () => {
    assert.deepEqual(await settleWithin(Promise.resolve([1]), 1000), [1]);
    const started = performance.now();
    assert.equal(await settleWithin(new Promise(() => {}), 50), undefined);
    assert.ok(performance.now() - started < 1000);
  });

  it("tells its whole rule in one sentence, as each tool does", () => {
    const tool = toolList().find((entry) => entry.name === "report_problem")!;
    assert.match(String(tool.description), /^[A-Z][^.]*\.$/);
    for (const words of ["ZEN_INTERNAL twice", "never a site's errors", "once per problem", "never send or file a report yourself", "stop and tell the user"]) {
      assert.ok(String(tool.description).includes(words), words);
    }
    assert.deepEqual((tool.inputSchema as { required: string[] }).required, ["line"]);
    assert.deepEqual(tool.annotations, { title: "Report a problem with zenius", readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });
});

describe("zenius mcp hand_off", () => {
  it("passes the agent's reason on to the task's hand-off, and leaves out one that isn't one of the four", async () => {
    const handOffs: unknown[] = [];
    const session = {
      connect() {},
      async resume() {},
      async watchDownloads() {},
      downloadNews: () => [],
      drop() {},
      ended() {},
      task: {
        async handOff(options: unknown) {
          handOffs.push(options);
        },
      },
    } as unknown as Parameters<typeof callTool>[0];
    const handOff = async (args: Record<string, unknown>) => {
      const result = await callTool(session, "hand_off", args);
      assert.equal(result.isError, undefined, result.content[0]!.text);
      return handOffs.at(-1);
    };
    assert.deepEqual(await handOff({ message: "Sign in to Accounts", reason: "sign_in" }), { message: "Sign in to Accounts", reason: "sign_in" });
    assert.deepEqual(await handOff({ message: "Copy your new API token", reason: "other", secret: true }), {
      message: "Copy your new API token",
      secret: true,
      reason: "other",
    });
    assert.deepEqual(await handOff({ message: "Solve the puzzle" }), { message: "Solve the puzzle" });
    // The user's step goes ahead without a label rather than fail over it.
    assert.deepEqual(await handOff({ message: "Log in", reason: "login" }), { message: "Log in" });
  });
});

describe("zenius mcp hard stops", () => {
  it("say which browser prompt paused the task, by the runtime's reason key", async () => {
    const paused = async (reason: string) => {
      const session = {
        connect() {},
        async resume() {
          throw new ZeniusError("ZEN_TASK_SPACE_USER_IN_CONTROL", "Control is with the user", { reason });
        },
        downloadNews: () => [],
        drop() {},
        ended() {},
      } as unknown as Parameters<typeof callTool>[0];
      const result = await callTool(session, "read_page", {});
      assert.equal(result.isError, true);
      return /Zen is showing the user (.*) in the task's tab/.exec(result.content[0]!.text)?.[1];
    };
    assert.equal(await paused("location"), "a prompt asking for their location");
    assert.equal(await paused("notifications"), "a prompt asking to send them notifications");
    assert.equal(await paused("midi"), "a prompt asking for their MIDI devices");
    assert.equal(await paused("serial"), "a prompt asking to connect to a serial port");
    assert.equal(await paused("storage_access"), "a prompt asking for storage access");
    assert.equal(await paused("permission_prompt"), "a browser prompt, such as a passkey request, or one asking for persistent storage or virtual reality");
    // A key from a later runtime still says it's a prompt, by its key.
    assert.equal(await paused("bluetooth"), "a browser prompt (bluetooth)");
  });
});

/**
 * A real session on a mock runtime, which sends the download events a test
 * gives it (MockRuntime.emit), as the runtime sends them to a subscriber.
 */
async function withSession(
  body: (context: {
    session: Session;
    mock: MockRuntime;
    call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
    download: (id: string, state: string, more?: Record<string, unknown>) => void;
  }) => Promise<void>,
): Promise<void> {
  const mock = await new MockRuntime().start();
  const socket = process.env.ZENIUS_SOCKET;
  process.env.ZENIUS_SOCKET = mock.socketPath;
  const session = new Session({});
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await callTool(session, name, args);
    return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError };
  };
  const download = (id: string, state: string, more: Record<string, unknown> = {}) =>
    mock.emit("download", { space: session.task.id, page: "p1", download: id, url: "https://shop.example.com/r", suggestedFilename: "report.pdf", state, ...more });
  try {
    await call("open", { url: "https://shop.example.com/" });
    await body({ session, mock, call, download });
  } finally {
    session.drop();
    if (socket === undefined) delete process.env.ZENIUS_SOCKET;
    else process.env.ZENIUS_SOCKET = socket;
    await mock.stop();
  }
}

const TOO_MANY =
  "zenius refused a download from https://shop.example.com/big: the task holds 50 downloads, the most it may (zenius.observe.downloads.maxCount). Tell the user.";

describe("zenius mcp downloads", () => {
  it("hears the task's download events from its open on, through one subscription to the task's own", async () => {
    await withSession(async ({ session, mock, call }) => {
      const subscribed = mock.requests.filter((request) => request.method === "events.subscribe");
      assert.deepEqual(
        subscribed.map((request) => request.params),
        [{ names: ["download"], space: session.task.id }],
      );
      const open = mock.requests.findIndex((request) => request.method === "page.goto");
      assert.ok(mock.requests.indexOf(subscribed[0]!) < open, "before the first page, which may be a download");
      await call("read_page", {});
      assert.equal(mock.requests.filter((request) => request.method === "events.subscribe").length, 1);
    });
  });

  it("goes on when the subscription fails, and the next call subscribes again", async () => {
    const mock = await new MockRuntime().start();
    const socket = process.env.ZENIUS_SOCKET;
    process.env.ZENIUS_SOCKET = mock.socketPath;
    const session = new Session({});
    let failed = 0;
    mock.handle("events.subscribe", () => {
      if (!failed++) throw new Error("not now");
      return { ok: true };
    });
    try {
      const opened = await callTool(session, "open", { url: "https://shop.example.com/" });
      assert.equal(opened.isError, undefined, opened.content[0]!.text);
      await callTool(session, "read_page", {});
      assert.equal(mock.requests.filter((request) => request.method === "events.subscribe").length, 2);
      mock.emit("download", { space: session.task.id, page: "p1", download: "download-1", suggestedFilename: "report.pdf", state: "started" });
      const read = await callTool(session, "read_page", {});
      assert.match(read.content[0]!.text, /\np1 started downloading "report\.pdf"/);
      assert.equal(mock.requests.filter((request) => request.method === "events.subscribe").length, 2, "once it holds, no more");
    } finally {
      session.drop();
      if (socket === undefined) delete process.env.ZENIUS_SOCKET;
      else process.env.ZENIUS_SOCKET = socket;
      await mock.stop();
    }
  });

  it("tells the agent in the next result what the task's downloads did, once each: started, in the working folder with home as ~, or failed with the reason", async () => {
    await withSession(async ({ session, mock, call, download }) => {
      download("download-1", "started");
      const clicked = await call("click", { element: "Download", target: "#download" });
      assert.equal(
        clicked.text,
        [
          'Click "Download"',
          "Done.",
          `p1 started downloading "report.pdf": zenius says when it's in the working folder, and finishing the task before then cancels it.`,
        ].join("\n"),
      );
      download("download-1", "finished", { path: join(homedir(), "zenius-files", "report(1).pdf") });
      download("refused-1", "failed", { page: null, suggestedFilename: "", failure: TOO_MANY });
      download("download-2", "started", { suggestedFilename: "Invoice\u202Etxt.exe\n2024.pdf" });
      download("download-2", "failed", { suggestedFilename: "Invoice\u202Etxt.exe\n2024.pdf", failure: "canceled" });
      // Another task's download and an event that isn't one say nothing.
      mock.emit("download", { space: session.task.id + 1, page: "p1", download: "download-9", suggestedFilename: "theirs.pdf", state: "started" });
      mock.emit("popup", { space: session.task.id, page: "p1", label: "p2" });
      const waited = await call("wait", { downloads: true });
      assert.equal(
        waited.text,
        [
          "Wait for the downloads to finish",
          "No download of the task is running now.",
          `p1 downloaded "report.pdf": it's in the working folder, ~/zenius-files, as "report(1).pdf".`,
          `A download failed: ${TOO_MANY}`,
          `p1's download of "Invoicetxt.exe 2024.pdf" failed: canceled`,
        ].join("\n"),
      );
      assert.equal((await call("read_page", {})).text.includes("download"), false, "each is told once");
    });
  });

  it("leaves out a download refusal that the action's receipt gives, and tells a later one", async () => {
    await withSession(async ({ mock, call, download }) => {
      mock.handle("page.click", () => {
        download("refused-1", "failed", { suggestedFilename: "", failure: TOO_MANY });
        return { refused: [{ kind: "download", message: TOO_MANY }] };
      });
      const clicked = await call("click", { element: "Download", target: "#download" });
      assert.equal(clicked.text, ['Click "Download"', "Done.", `zenius refused something the page tried: ${TOO_MANY}`].join("\n"));
      download("refused-2", "failed", { suggestedFilename: "", failure: TOO_MANY });
      assert.equal((await call("wait", { downloads: true })).text.split("\n").at(-1), `p1's download failed: ${TOO_MANY}`);
    });
  });

  it("waits with downloads: true until the running ones end, up to its seconds, and says which still run", async () => {
    await withSession(async ({ call, download }) => {
      download("download-1", "started");
      const ends = setTimeout(() => download("download-1", "finished", { path: "/srv/files/report.pdf" }), 100);
      const started = performance.now();
      const waited = await call("wait", { downloads: true, seconds: 5 });
      clearTimeout(ends);
      assert.ok(performance.now() - started < 2000, "it returns when they end");
      assert.match(waited.text, /^Wait for the downloads to finish\nNo download of the task is running now\.\n/);
      assert.match(waited.text, /\np1 downloaded "report\.pdf": it's in the working folder, \/srv\/files, as "report\.pdf"\.$/);

      download("download-2", "started", { suggestedFilename: "a.zip" });
      download("download-3", "started", { suggestedFilename: "b.zip" });
      const late = await call("wait", { downloads: true, seconds: 0.2 });
      assert.equal(
        late.text.split("\n").slice(0, 2).join("\n"),
        'Wait for the downloads to finish\nNot yet: "a.zip" and "b.zip" are still downloading after 0.2 seconds. Call wait with downloads: true again to go on waiting.',
      );
    });
  });

  it("finish refuses while a download runs, naming it and both ways on, and cancel_downloads: true finishes and says what it canceled", async () => {
    await withSession(async ({ mock, call, download }) => {
      download("download-1", "started");
      const refused = await call("finish", { keep: "none" });
      assert.equal(refused.isError, true);
      assert.equal(
        refused.text.split("\n").slice(0, 2).join("\n"),
        `Finish, closing the task's tabs failed.\n"report.pdf" is still downloading, and finishing the task now would cancel it. Wait for it with wait and downloads: true, or call finish with cancel_downloads: true to cancel it.`,
      );
      assert.ok(!mock.requests.some((request) => request.method === "spaces.finish"), "the task goes on");
      const finished = await call("finish", { keep: "none", cancel_downloads: true });
      assert.equal(finished.isError, undefined, finished.text);
      assert.match(finished.text, /The task is finished: closed p1\. It canceled "report\.pdf", which was still downloading\.$/);
      // The ended task's last events say nothing.
      mock.emit("download", { space: 1, page: "p1", download: "download-1", suggestedFilename: "report.pdf", state: "failed", failure: "canceled" });
      assert.equal((await call("wait", { downloads: true })).text, "Wait for the downloads to finish\nNo download of the task is running now.");
    });
  });

  it("finishes at once when no download runs, saying nothing of downloads", async () => {
    await withSession(async ({ call, download }) => {
      download("download-1", "started");
      download("download-1", "finished", { path: "/srv/files/report.pdf" });
      const finished = await call("finish", { keep: "none" });
      assert.equal(finished.isError, undefined, finished.text);
      assert.doesNotMatch(finished.text, /canceled/);
    });
  });
});

type Answer = { id?: unknown; result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };

/** The checkout: what the launcher grants a server to read. */
const CHECKOUT = dirname(dirname(dirname(CLI)));

/**
 * zenius mcp itself on stdio, against `mock`, as a client starts it. With
 * `sandbox`, under Node's permission model as the launcher starts it, with
 * its grants, so the server offers its script tool.
 */
function startServer(mock: MockRuntime, sandbox?: { tmp: string; work: string }) {
  const env = guardHome(
    {
      ...process.env,
      ZENIUS_INSTANCE: "",
      ZENIUS_TIMING: "",
      ZENIUS_SOCKET: mock.socketPath,
      ...(sandbox ? { ZENIUS_NODE_MAJOR: process.versions.node.split(".")[0], TMPDIR: sandbox.tmp, ZENIUS_WORKING_DIR: sandbox.work } : {}),
    },
    "zenius mcp's tests",
  );
  const grants = sandbox
    ? [
        "--permission",
        `--allow-fs-read=${CHECKOUT}`,
        `--allow-fs-read=${mock.dir}`,
        `--allow-fs-read=${sandbox.tmp}`,
        `--allow-fs-write=${sandbox.tmp}`,
        `--allow-fs-read=${sandbox.work}`,
        `--allow-fs-write=${sandbox.work}`,
      ]
    : [];
  const child = spawn(process.execPath, [...grants, CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const answered: unknown[] = [];
  const waiting = new Map<unknown, (answer: Answer) => void>();
  let stderr = "";
  let buffer = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const answer = JSON.parse(line) as Answer;
      answered.push(answer.id);
      waiting.get(answer.id)?.(answer);
    }
  });
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return {
    send,
    answered,
    request(id: number, method: string, params: Record<string, unknown>): Promise<Answer> {
      const answer = new Promise<Answer>((resolve, reject) => {
        waiting.set(id, resolve);
        setTimeout(() => reject(new Error(`no answer to ${method} (${id}) in 10 s; stderr: ${stderr}`)), 10_000).unref();
      });
      send({ id, method, params });
      return answer;
    },
    async stop(): Promise<void> {
      child.stdin.end();
      const closed = new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once("close", resolve)));
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await closed;
      clearTimeout(kill);
    },
  };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > ms) throw new Error(`not so after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("zenius mcp pages that load afresh", () => {
  it("evaluate's result says what its code left that loads the page afresh, a failed call's too, and the next tool's result doesn't say it again", async () => {
    await withSession(async ({ mock, call }) => {
      mock.handle("page.evaluate", (params) => {
        if (String(params.fn).includes("throw")) throw Object.assign(new MockError("ZEN_EVALUATION_FAILED", "Error: after"), { hooked: "a style sheet" });
        return new Hooked(3, "a form");
      });
      const ran = await call("evaluate", { code: "() => 3" });
      assert.equal(ran.text, ["Run code in the page", "3", hookedNotice("page.evaluate", "p1", "a form")].join("\n"));
      const failed = await call("evaluate", { code: "() => { throw new Error('after'); }" });
      assert.equal(failed.isError, true);
      assert.ok(failed.text.endsWith(`\n${hookedNotice("page.evaluate", "p1", "a style sheet")}`), failed.text);
      mock.unhandle("page.evaluate");
      const again = await call("evaluate", { code: "() => document.title" });
      assert.doesNotMatch(again.text, /costs it a reload/);
    });
  });
});

describe("zenius mcp cancel", () => {
  it("answers a canceled call nothing, stops its wait in the runtime, and starts the next call at once, skipping one canceled in the queue", async () => {
    const mock = await new MockRuntime().start();
    // The runtime's wait for the user holds until the user resumes the agent.
    const waits: number[] = [];
    mock.handle("spaces.waitForControl", (_params, { frame }) => {
      waits.push(frame.id);
      return new Promise(() => {});
    });
    const server = startServer(mock);
    try {
      await server.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client" } });
      const opened = await server.request(2, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      assert.equal(opened.result?.isError, undefined, opened.result?.content[0]?.text);
      // A wait for the user, and another queued behind it.
      server.send({ id: 3, method: "tools/call", params: { name: "wait", arguments: { user: true } } });
      server.send({ id: 4, method: "tools/call", params: { name: "wait", arguments: { user: true } } });
      await until(() => waits.length === 1);
      const canceled = performance.now();
      server.send({ method: "notifications/cancelled", params: { requestId: 4, reason: "the user sent a message" } });
      server.send({ method: "notifications/cancelled", params: { requestId: 3, reason: "the user sent a message" } });
      const read = await server.request(5, "tools/call", { name: "read_page", arguments: {} });
      assert.ok(performance.now() - canceled < 3000, `the next call answered ${Math.round(performance.now() - canceled)} ms after the cancels`);
      assert.equal(read.result?.isError, undefined, read.result?.content[0]?.text);
      assert.match(read.result!.content[0]!.text, /^Read the page\n/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(server.answered, [1, 2, 5], "the canceled calls got no answer");
      assert.deepEqual(waits.length, 1, "the queued wait never ran");
      assert.deepEqual(mock.canceled, waits, "the runtime was told to stop the wait it ran");
    } finally {
      await server.stop();
      await mock.stop();
    }
  });
});

/** A scratch TMPDIR and working folder for a sandboxed server, gone after `body`. */
async function withSandbox(body: (sandbox: { tmp: string; work: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "zmcp-"));
  chmodSync(root, 0o700);
  const sandbox = { tmp: join(root, "tmp"), work: join(root, "work") };
  mkdirSync(sandbox.tmp, { mode: 0o700 });
  mkdirSync(sandbox.work, { mode: 0o700 });
  try {
    await body(sandbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A sandboxed server on a mock runtime, initialized. */
async function withScriptServer(body: (context: { server: ReturnType<typeof startServer>; mock: MockRuntime }) => Promise<void>): Promise<void> {
  const mock = await new MockRuntime().start();
  try {
    await withSandbox(async (sandbox) => {
      const server = startServer(mock, sandbox);
      try {
        await server.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client" } });
        await body({ server, mock });
      } finally {
        await server.stop();
      }
    });
  } finally {
    await mock.stop();
  }
}

const textOf = (answer: Answer): string => (answer.result?.content ?? []).map((part) => part.text).join("\n");

describe("zenius mcp script", () => {
  it("is never offered outside the permission model: a plain CLI's server leaves it out, and its instructions don't name it", async () => {
    const mock = await new MockRuntime().start();
    const server = startServer(mock);
    try {
      const init = (await server.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client" } })) as {
        result?: { instructions?: string };
      };
      assert.doesNotMatch(String(init.result?.instructions), /\bscript\b/);
      const tools = (await server.request(2, "tools/list", {})) as { result?: { tools?: Array<{ name: string }> } };
      assert.ok(tools.result?.tools?.length, "it lists the other tools");
      assert.ok(!tools.result!.tools!.some((tool) => tool.name === "script"));
      const called = await server.request(3, "tools/call", { name: "script", arguments: { code: "return 1", purpose: "p" } });
      assert.equal(called.result?.isError, true);
      assert.match(textOf(called), /There is no tool named "script"/);
    } finally {
      await server.stop();
      await mock.stop();
    }
  });

  it("runs a script on a connection of its own, whose step begins in the server's task with its purpose and ends with ok", async () => {
    await withScriptServer(async ({ server, mock }) => {
      const tools = (await server.request(2, "tools/list", {})) as { result?: { tools?: Array<{ name: string }> } };
      assert.ok(tools.result?.tools?.some((tool) => tool.name === "script"), "offered under the permission model");
      const opened = await server.request(3, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      assert.equal(opened.result?.isError, undefined, textOf(opened));
      const ran = await server.request(4, "tools/call", {
        name: "script",
        arguments: { code: "console.log('title:', await page.title()); return 42;", purpose: "Read the title" },
      });
      assert.equal(ran.result?.isError, undefined, textOf(ran));
      assert.match(textOf(ran), /^Run a script: "Read the title"\ntitle: .*\nReturned: 42/);
      const [space] = [...mock.spaces.keys()];
      const begin = mock.requests.find((request) => request.method === "script.begin")!;
      assert.deepEqual(begin.params, { space, purpose: "Read the title" });
      const own = mock.requests.find((request) => request.method === "page.goto")!.connection;
      assert.notEqual(begin.connection, own, "not the server's own connection");
      assert.deepEqual(
        mock.requests.filter((request) => request.connection === begin.connection && ["script.begin", "page.title", "script.end"].includes(request.method)).map((request) => request.method),
        ["script.begin", "page.title", "script.end"],
        "its calls go between its step's begin and end, on its connection",
      );
      assert.deepEqual(mock.requests.find((request) => request.method === "script.end")!.params, { outcome: "ok" });
    });
  });

  it("ends the step with failed for the script's own error, and ZEN_TIMEOUT at its time limit", async () => {
    await withScriptServer(async ({ server, mock }) => {
      await server.request(2, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      const failed = await server.request(3, "tools/call", { name: "script", arguments: { code: "throw new Error('boom')", purpose: "Fail" } });
      assert.equal(failed.result?.isError, true, textOf(failed));
      const late = await server.request(4, "tools/call", { name: "script", arguments: { code: "await new Promise((resolve) => setTimeout(resolve, 4000))", purpose: "Wait", seconds: 1 } });
      assert.match(textOf(late), /ran past its 1 s limit/);
      assert.deepEqual(
        mock.requests.filter((request) => request.method === "script.end").map((request) => request.params.outcome),
        ["failed", "ZEN_TIMEOUT"],
      );
    });
  });

  it("lists what the script's page code left that loads a page afresh among the server's lines", async () => {
    await withScriptServer(async ({ server, mock }) => {
      mock.handle("page.evaluate", () => new Hooked(1, "a style sheet"));
      const opened = await server.request(3, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      assert.equal(opened.result?.isError, undefined, textOf(opened));
      const ran = await server.request(4, "tools/call", {
        name: "script",
        arguments: { code: "return await page.evaluate(() => 1);", purpose: "Move a piece" },
      });
      assert.equal(ran.result?.isError, undefined, textOf(ran));
      const blocks = (ran.result?.content ?? []).map((part) => part.text);
      assert.match(blocks[0] ?? "", /^Run a script: "Move a piece"\nReturned: 1/);
      assert.deepEqual(blocks[1]?.split("\n"), [hookedNotice("page.evaluate", "p1", "a style sheet")], textOf(ran));
    });
  });

  it("begins the step in the task the script starts, on its own connection, once the task is there", async () => {
    await withScriptServer(async ({ server, mock }) => {
      const ran = await server.request(2, "tools/call", { name: "script", arguments: { code: "return (await taskSpace('Flights')).name;", purpose: "Start the task" } });
      assert.equal(ran.result?.isError, undefined, textOf(ran));
      assert.match(textOf(ran), /Started the task "Flights"\./);
      const created = mock.requests.find((request) => request.method === "spaces.create")!;
      const begin = mock.requests.find((request) => request.method === "script.begin")!;
      assert.equal(begin.connection, created.connection);
      assert.ok(mock.requests.indexOf(begin) > mock.requests.indexOf(created));
      assert.deepEqual(begin.params, { space: [...mock.spaces.keys()][0], purpose: "Start the task" });
    });
  });

  it("gives what a script left running no more calls once its call is over: a later call fails at once, and one still waiting stops in the runtime, while the server ends the step", async () => {
    await withScriptServer(async ({ server, mock }) => {
      await server.request(2, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      // The step's end holds the connection a while, as a slow runtime's would.
      mock.handle("script.end", () => new Promise((resolve) => setTimeout(() => resolve({ ended: true }), 800)));
      let waitId: number | undefined;
      mock.handle("page.waitForSelector", (_params, { frame }) => {
        waitId = frame.id;
        return new Promise(() => {});
      });
      const ran = await server.request(3, "tools/call", {
        name: "script",
        arguments: {
          code: "page.waitForSelector('#never', { timeout: 60000 }).catch(() => {}); setTimeout(() => page.title().catch(() => {}), 300); return 1;",
          purpose: "Leave work behind",
        },
      });
      assert.equal(ran.result?.isError, undefined, textOf(ran));
      assert.match(textOf(ran), /Returned: 1/);
      assert.ok(waitId !== undefined, "the wait reached the runtime");
      assert.deepEqual(mock.canceled, [waitId], "the wait it left stops in the runtime");
      // The open tool reads the title on the server's own connection.
      const script = mock.requests.find((request) => request.method === "script.begin")!.connection;
      assert.deepEqual(
        mock.requests.filter((request) => request.connection === script && request.method === "page.title"),
        [],
        "the call its timer makes later never reaches the runtime",
      );
      assert.deepEqual(mock.requests.find((request) => request.method === "script.end")!.params, { outcome: "ok" });
    });
  });

  it("stays responsive when a script past its limit retries a call in a loop: each refusal waits a turn of the event loop", async () => {
    await withScriptServer(async ({ server }) => {
      await server.request(2, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      const late = await server.request(3, "tools/call", {
        name: "script",
        arguments: { code: "for (;;) { try { await page.title(); } catch {} }", purpose: "Loop", seconds: 1 },
      });
      assert.match(textOf(late), /ran past its 1 s limit/);
      const read = await server.request(4, "tools/call", { name: "read_page", arguments: {} });
      assert.equal(read.result?.isError, undefined, `the server goes on: ${textOf(read)}`);
    });
  });

  it("counts a file whose name starts with two dots as the working folder's own: only .. and what's under it are outside", () => {
    assert.equal(insideFolder("/w", "/w/..notes.txt"), "..notes.txt");
    assert.equal(insideFolder("/w", "/w/a/..b"), "a/..b");
    assert.equal(insideFolder("/w", "/w"), "");
    assert.equal(insideFolder("/w", "/"), undefined);
    assert.equal(insideFolder("/w", "/w2/x"), undefined);
    assert.equal(insideFolder("/w", "/x/..notes.txt"), undefined);
  });

  it("ends the call at once when the user stops the script in the sidebar, says so, and sends no end: the runtime ended its step", async () => {
    await withScriptServer(async ({ server, mock }) => {
      await server.request(2, "tools/call", { name: "open", arguments: { url: "https://shop.example.com/" } });
      let script: Socket | undefined;
      mock.handle("page.waitForSelector", (_params, { socket }) => {
        script = socket;
        return new Promise(() => {});
      });
      const stopped = server.request(3, "tools/call", {
        name: "script",
        arguments: { code: "await page.waitForSelector('#never', { timeout: 60000 }); return 1;", purpose: "Wait for the button" },
      });
      await until(() => script !== undefined);
      // As the runtime's stopScript does: say why, then close.
      script!.write(`${JSON.stringify({ event: "scriptStopped", params: { step: 1 } })}\n`);
      script!.destroy();
      const answer = await stopped;
      assert.equal(answer.result?.isError, true);
      assert.match(textOf(answer), /^Run a script: "Wait for the button" stopped\.\nThe user stopped the script with Stop in Zen's sidebar/);
      assert.equal(mock.requests.filter((request) => request.method === "script.end").length, 0);
      const read = await server.request(4, "tools/call", { name: "read_page", arguments: {} });
      assert.equal(read.result?.isError, undefined, `the server's own connection goes on: ${textOf(read)}`);
    });
  });
});
