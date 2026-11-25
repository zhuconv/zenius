// zenius mcp's steps (zen-core's src/mcp.ts), as a call's arguments give
// them: the lines the user reads in the sidebar, and what a failure shows.
// They must never show a typed secret, a URL's token, or text that reads as
// something else. test/integration/mcp.it.ts drives the
// server against a dev Zen.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { guardHome } from "../../tests/lib/scratch-home.mjs";
import { ZeniusError } from "../src/errors.ts";
import { settleWithin } from "../src/feedback.ts";
import { callTool, reportWaitS, Session, stepFor, toolList } from "../src/mcp.ts";
import { CLI } from "./helpers.ts";
import { MockRuntime } from "./mock-runtime.ts";

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

/** zenius mcp itself on stdio, against `mock`, as a client starts it. */
function startServer(mock: MockRuntime) {
  const env = guardHome({ ...process.env, ZENIUS_INSTANCE: "", ZENIUS_TIMING: "", ZENIUS_SOCKET: mock.socketPath }, "zenius mcp's cancel test");
  const child = spawn(process.execPath, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
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
