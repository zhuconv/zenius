// zenius mcp's steps (zen-core's src/mcp.ts), as a call's arguments give
// them: the lines the user reads in the sidebar, and what a failure shows.
// They must never show a typed secret, a URL's token, or text that reads as
// something else. test/integration/mcp.it.ts drives the
// server against a dev Zen.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZeniusError } from "../src/errors.ts";
import { settleWithin } from "../src/feedback.ts";
import { callTool, reportWaitS, stepFor, toolList } from "../src/mcp.ts";

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
