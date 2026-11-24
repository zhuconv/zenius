// The SDK in-process against the mock runtime: each public call becomes the
// right request, results come back in Ego's shapes, and errors keep Ego's
// codes and wording.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { ZeniusError } from "../src/errors.ts";
import { claimTaskSpace, listTaskSpaces, profiles, startTaskSpace, takeOverTaskSpace, taskSource, taskSpace } from "../src/globals.ts";
import { flushOutput, hasHardStop } from "../src/output.ts";
import { clientLimitMs, type Download, Page, type RefusedEvent } from "../src/page.ts";
import { UnmanagedPage } from "../src/task-space.ts";
import { withMock } from "./helpers.ts";
import { MOCK_PNG, MockError, type MockSpace } from "./mock-runtime.ts";

// A Node-side name a page callback cannot see, and a Page global callbacks use.
declare const nodeOnlyVariable: number;
declare const location: { href: string };

/** The upload payload for a file, as the SDK reads it. */
function payload(file: string, text?: string): Record<string, unknown> {
  const bytes = readFileSync(file);
  if (text !== undefined) assert.equal(bytes.toString("utf8"), text);
  return {
    name: file.slice(file.lastIndexOf("/") + 1),
    mimeType: "",
    lastModified: Math.round(statSync(file).mtimeMs),
    base64: bytes.toString("base64"),
  };
}

function captureFlush(thrown = false): string {
  let out = "";
  flushOutput(thrown, (chunk) => (out += chunk));
  return out;
}

/** Run `body` with environment variables set, restoring them afterwards. */
async function withEnv(values: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The agent variables clientLabel() and taskSource() read, set as given and otherwise unset, around fn. */
async function withAgentEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const names = ["ZENIUS_CLIENT", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "HC_TERMINAL_ID", "ZENIUS_SIDEBAR_TASK"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

describe("globals", () => {
  it("task.page(label) knows its tab and origin as soon as taskSpace() returns, as Ego's ledger does", () =>
    withMock(async () => {
      const first = await taskSpace("ledger");
      assert.equal(typeof first.page("p1").targetId, "string");
      const p2 = await first.newPage();
      // A later script gets fresh handles and lists nothing.
      const again = await taskSpace("ledger");
      assert.equal(again.page("p1").targetId, first.page("p1").targetId);
      assert.equal(again.page("p2").targetId, p2.targetId);
      assert.equal(again.page("p2").openedBy, "agent");
      assert.equal(again.page("p9").targetId, undefined);
    }));

  it("takes the Pages' tabs from the runtime's replies, and makes one pages.list for a label without its tab", () =>
    withMock(async ({ mock }) => {
      const created = await taskSpace("tabs in reply");
      assert.equal(created.page("p1").targetId, mock.spaces.get(created.id)!.pages[0]!.tab);
      assert.equal(created.page("p1").openedBy, "agent");
      assert.deepEqual(mock.methods(), ["spaces.list", "spaces.create"], "no pages.list: the reply named the tab");

      // An existing space: its spaces.list entry names the tabs.
      await created.newPage();
      const again = await taskSpace("tabs in reply");
      assert.equal(again.page("p2").targetId, mock.spaces.get(created.id)!.pages[1]!.tab);
      assert.equal(mock.methods().filter((method) => method === "pages.list").length, 0);
      const listed = (await listTaskSpaces()).find((space) => space.id === created.id)!;
      assert.equal("pages" in listed, false, "listTaskSpaces() keeps Ego's shape");

      // A runtime from before tab ids lists bare labels: one pages.list fills them in.
      mock.handle("spaces.list", () => ({
        taskSpaces: [...mock.spaces.values()].map((space) => ({ id: space.id, name: space.name, ownership: space.ownership, pages: ["p1", "p2"] })),
      }));
      const older = await taskSpace("tabs in reply");
      assert.equal(older.page("p1").targetId, mock.spaces.get(created.id)!.pages[0]!.tab);
      assert.equal(mock.methods().filter((method) => method === "pages.list").length, 1);
    }));

  it("learning the Pages never fails taskSpace() or records a hard stop the script didn't meet", () =>
    withMock(async ({ mock }) => {
      // A reply without tab ids, so the SDK asks pages.list, which fails.
      mock.handle("spaces.create", (params) => {
        const space = mock.addSpace(params.name, "agent");
        mock.addPage(space);
        return { id: space.id, name: space.name, ownership: "agent", pages: ["p1"] };
      });
      mock.handle("pages.list", () => {
        throw new MockError("ZEN_TASK_SPACE_USER_IN_CONTROL", "The user is using this task space.", { reason: "paused" });
      });
      const task = await taskSpace("quiet ledger");
      assert.equal(task.page("p1").targetId, undefined);
      assert.equal(hasHardStop(), false);
    }));

  it("profiles() returns the runtime's profiles", () =>
    withMock(async () => {
      const list = await profiles();
      assert.deepEqual(
        list.map((profile) => profile.id),
        ["default", "container-2"],
      );
    }));

  it("taskSpace(name) creates a space with p1 and reuses it by name or id", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("demo");
      assert.equal(task.name, "demo");
      assert.equal(task.ownership, "agent");
      assert.equal(task.spaceId, task.id);
      // spaces.create names p1's tab, so task.page(label).targetId answers at once.
      assert.deepEqual(mock.methods(), ["spaces.list", "spaces.create"]);
      const again = await taskSpace("demo");
      assert.equal(again.id, task.id);
      const byId = await taskSpace(task.id);
      assert.equal(byId.name, "demo");
      const byIdString = await taskSpace(String(task.id));
      assert.equal(byIdString.id, task.id);
      assert.equal(mock.methods().filter((method) => method === "spaces.create").length, 1);
    }));

  it("startTaskSpace starts a task of its own: a taken name gets a number, cut before it to fit", () =>
    withMock(async ({ mock }) => {
      const theirs = mock.addSpace("Tokyo flights", "agent");
      mock.addSpace("Tokyo flights 2", "user", "user");
      const task = await startTaskSpace("  Tokyo flights ");
      assert.equal(task.name, "Tokyo flights 3");
      assert.equal(task.ownership, "agent");
      assert.notEqual(task.id, theirs.id);
      assert.deepEqual(mock.methods(), ["spaces.list", "spaces.create"]);

      // A name cut to fit keeps its number: the cut comes before it.
      const long = `${"word ".repeat(20)}end`;
      assert.equal((await startTaskSpace(long, { maxLength: 80 })).name, "word ".repeat(16).trimEnd());
      const second = (await startTaskSpace(long, { maxLength: 80 })).name;
      assert.equal(second, `${"word ".repeat(15).trimEnd()} 2`);
      assert.ok(Array.from(second).length <= 80);

      // Taken since the listing (another client started it): the runtime refuses it, and the next number goes.
      mock.handle("spaces.list", () => ({ taskSpaces: [] }));
      assert.equal((await startTaskSpace("Tokyo flights")).name, "Tokyo flights 4");
      assert.equal([...mock.spaces.values()].filter((space) => space.name === "Tokyo flights").length, 1);
    }));

  it("startTaskSpace gives up after 20 names taken since its listing, and passes other errors on", () =>
    withMock(async ({ mock }) => {
      mock.handle("spaces.create", () => {
        throw new MockError("ZEN_TASK_SPACE_NAME_IN_USE", "taken");
      });
      await assert.rejects(() => startTaskSpace("busy"), (error: unknown) => error instanceof ZeniusError && error.code === "ZEN_TASK_SPACE_NAME_IN_USE");
      assert.equal(mock.methods().filter((method) => method === "spaces.create").length, 21);
      mock.handle("spaces.create", () => {
        throw new MockError("ZEN_BROWSER_UNAVAILABLE", "gone");
      });
      await assert.rejects(() => startTaskSpace("busy"), (error: unknown) => error instanceof ZeniusError && error.code === "ZEN_BROWSER_UNAVAILABLE");
      await assert.rejects(() => startTaskSpace(" "), /expects a task name/);
    }));

  it("taskSpace rejects bad locators before any request", () =>
    withMock(async ({ mock }) => {
      await assert.rejects(() => taskSpace(undefined as never), /expects a task-space name/);
      await assert.rejects(() => taskSpace("  "), /expects a task-space name/);
      await assert.rejects(() => taskSpace("x", { color: "red" } as never), /received unknown option: color/);
      assert.equal(mock.requests.length, 0);
    }));

  it("taskSpace(id) that does not exist fails with ZEN_TASK_SPACE_NOT_FOUND", () =>
    withMock(async () => {
      await assert.rejects(
        () => taskSpace(42),
        (error: any) => error.code === "ZEN_TASK_SPACE_NOT_FOUND" && error.error_code === "ZEN_TASK_SPACE_NOT_FOUND" && /task space not found: 42/.test(error.message),
      );
    }));

  it("a user Space with the same name fails with ZEN_TASK_SPACE_NAME_IN_USE", () =>
    withMock(async ({ mock }) => {
      const space = mock.addSpace("Research", "user", "user");
      await assert.rejects(
        () => taskSpace("Research"),
        (error: any) =>
          error.code === "ZEN_TASK_SPACE_NAME_IN_USE" && error.message.includes(`claimTaskSpace(${space.id})`),
      );
      // By id it is returned unclaimed; its first command reports the stop.
      const task = await taskSpace(space.id);
      assert.equal(task.ownership, "user");
    }));

  it("profileId only applies to a new name", () =>
    withMock(async ({ mock }) => {
      await assert.rejects(() => taskSpace(3, { profileId: "default" }), /only be used with a new task-space name/);
      await taskSpace("one");
      await assert.rejects(() => taskSpace("one", { profileId: "default" }), /only applies when creating/);
      const task = await taskSpace("two", { profileId: "container-2" });
      assert.equal(task.name, "two");
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.create")?.params, { name: "two", profileId: "container-2", source: taskSource() });
    }));

  it("listTaskSpaces() fills taskId from the name, as Ego does", () =>
    withMock(async ({ mock }) => {
      mock.addSpace("", "user", "user");
      mock.addSpace("agent work", "agent");
      const spaces = await listTaskSpaces();
      assert.equal(spaces.length, 2);
      assert.equal(spaces[0]!.taskId, "");
      assert.equal(spaces[1]!.taskId, "agent work");
    }));

  it("claimTaskSpace claims by id, keeps the name, and records the user page", () =>
    withMock(async ({ mock }) => {
      const space = mock.addSpace("finished task", "user");
      mock.addPage(space, { managed: false, url: "https://kept.example/", openedBy: "agent" });
      const task = await withAgentEnv({}, () => claimTaskSpace(space.id));
      assert.equal(task.ownership, "agent");
      assert.deepEqual(mock.requests.at(-1), {
        method: "spaces.claim",
        params: { space: space.id, name: "finished task", source: taskSource({}, process.cwd(), false) },
        receivedAt: mock.requests.at(-1)!.receivedAt,
      });
      const userPage = task.userPage();
      assert.ok(userPage instanceof UnmanagedPage);
      const adopted = await task.adopt(userPage as UnmanagedPage);
      assert.equal(adopted.label, "p1");
    }));

  it("claimTaskSpace names the agent for the user's prompt: ZENIUS_CLIENT, else Claude Code or Codex, else nothing", () =>
    withMock(async ({ mock }) => {
      for (const [vars, client] of [
        [{ ZENIUS_CLIENT: "  Research bot  ", CLAUDECODE: "1" }, "Research bot"],
        [{ CLAUDECODE: "1" }, "Claude Code"],
        [{ CODEX_SANDBOX: "seatbelt" }, "Codex"],
        [{ CODEX_SANDBOX_NETWORK_DISABLED: "1" }, "Codex"],
        [{ ZENIUS_CLIENT: "   ", CLAUDECODE: "0" }, undefined],
        [{}, undefined],
      ] as const) {
        const space = mock.addSpace(`claim ${JSON.stringify(vars)}`, "user");
        await withAgentEnv(vars, () => claimTaskSpace(space.id));
        assert.equal(mock.requests.at(-1)!.params.client, client, JSON.stringify(vars));
      }
    }));

  // The sidebar lists every zenius task by its source.
  // zen-core keeps each field that fits the label set and drops the rest, so a
  // task always starts; the SDK fits them first, so nothing useful is dropped.
  it("taskSource names the hc terminal, the agent's kind and the folder's name, fitted to the label set, and never a path", () => {
    assert.deepEqual(taskSource({ HC_TERMINAL_ID: "t5x", CLAUDECODE: "1" }, "/Users/me/Projects/zenius-eval", false), {
      terminal: "t5x",
      agent: "Claude Code",
      folder: "zenius-eval",
    });
    assert.deepEqual(taskSource({ CODEX_SANDBOX: "seatbelt" }, "/", false), { agent: "Codex" });
    assert.deepEqual(taskSource({ HC_TERMINAL_ID: "  " }, "/srv/work", false), { agent: "script", folder: "work" });
    assert.deepEqual(taskSource({ HC_TERMINAL_ID: " t5x\u202e ", ZENIUS_CLIENT: "Bot \u2603" }, "/tmp/My Project (2)", false), {
      terminal: "t5x-",
      agent: "Bot -",
      folder: "My Project -2-",
    });
    assert.deepEqual(taskSource({}, `/x/${"a".repeat(100)}`, false), { agent: "script", folder: "a".repeat(80) });
    // In the sandbox the working folder may not be granted, and the script then
    // starts in its temporary folder: the launcher names the real one.
    assert.deepEqual(taskSource({ ZENIUS_FOLDER: "zenius-eval", ZENIUS_CLIENT: "Codex" }, "/tmp/zenius-sandbox-501/run.Ab12Cd", true), {
      agent: "Codex",
      folder: "zenius-eval",
    });
    assert.deepEqual(taskSource({}, "/tmp/zenius-sandbox-501/run.Ab12Cd", true), { agent: "script" });
  });

  // The sidebar's own tasks (zen-ux gives its zenius server ZENIUS_SIDEBAR_TASK,
  // its conversation's uid): the sidebar matches on it, so it goes exactly as
  // given or not at all. Fitted like a label, it could name another chat.
  it("taskSource carries the sidebar's conversation id exactly as given, or not at all", () => {
    const uid = "3f2c9a10-7b4e-4c1d-9a2f-0e5d6c7b8a91";
    assert.deepEqual(taskSource({ ZENIUS_SIDEBAR_TASK: uid, CLAUDECODE: "1" }, "/srv/work", false), { agent: "Claude Code", folder: "work", sidebar: uid });
    assert.equal(taskSource({ ZENIUS_SIDEBAR_TASK: "a".repeat(64) }, "/tmp/zenius-sandbox-501/run.Ab12Cd", true).sidebar, "a".repeat(64));
    for (const odd of ["", ` ${uid}`, `${uid}\n`, "3f2c 9a10", "3f2c_9a10", `{${uid}}`, "a".repeat(65), "3f2c9a10\u202e"]) {
      assert.equal(taskSource({ ZENIUS_SIDEBAR_TASK: odd }, "/srv/work", false).sidebar, undefined, JSON.stringify(odd));
    }
  });

  it("taskSpace and claimTaskSpace send that source, which spaces.create and spaces.claim keep", () =>
    withMock(async ({ mock }) => {
      const sidebarEnv = { HC_TERMINAL_ID: "t5x", CLAUDECODE: "1", ZENIUS_SIDEBAR_TASK: "c0ffee-42" };
      await withAgentEnv(sidebarEnv, () => taskSpace("with a source"));
      const created = mock.requests.findLast((request) => request.method === "spaces.create")!.params.source;
      assert.deepEqual(created, taskSource(sidebarEnv, process.cwd(), false));
      assert.deepEqual([created.terminal, created.agent, created.sidebar], ["t5x", "Claude Code", "c0ffee-42"]);
      const space = mock.addSpace("claimed with a source", "user");
      await withAgentEnv({ CODEX_SANDBOX: "seatbelt" }, () => claimTaskSpace(space.id));
      const claimed = mock.requests.findLast((request) => request.method === "spaces.claim")!.params.source;
      assert.deepEqual(claimed, taskSource({ CODEX_SANDBOX: "seatbelt" }, process.cwd(), false));
      assert.equal(claimed.terminal, undefined);
    }));

  it("takeOverTaskSpace captures the user page only after a delegation", () =>
    withMock(async ({ mock }) => {
      const space = mock.addSpace("delegated", "agentDelegatedToUser");
      mock.addPage(space, { url: "https://login.example/" });
      const task = await takeOverTaskSpace(space.id);
      assert.equal(task.ownership, "agent");
      assert.ok(task.userPage() instanceof Page);
      assert.equal((task.userPage() as Page).label, "p1");
      const again = await takeOverTaskSpace(space.id);
      assert.equal(again.userPage(), undefined);
    }));

  it("reports openerCut once, and only when it's true; an ordinary hand back reports nothing", () =>
    withMock(async ({ mock }) => {
      const space = mock.addSpace("sign-in", "agentDelegatedToUser");
      mock.addPage(space, { url: "https://login.example/" });
      space.handBackOpenerCut = true;
      const task = await takeOverTaskSpace(space.id);
      assert.deepEqual(task.handBack, { openerCut: true });
      assert.ok(Object.isFrozen(task.handBack));
      assert.equal((await takeOverTaskSpace(space.id)).handBack, undefined, "reported once");

      const waiting = await taskSpace(space.id);
      await waiting.waitForControl({ timeout: 1000 });
      assert.equal(waiting.handBack, undefined, "nothing to report");
      space.handBackOpenerCut = true;
      await waiting.waitForControl({ timeout: 1000 });
      assert.deepEqual(waiting.handBack, { openerCut: true });

      const other = await taskSpace(space.id);
      space.handBackOpenerCut = "yes";
      await other.waitForControl({ timeout: 1000 });
      assert.equal(other.handBack, undefined, "only true is the flag");
    }));

  it("lists the Pages zenius reloaded before the hand back, once", () =>
    withMock(async ({ mock }) => {
      const space = mock.addSpace("held", "agentDelegatedToUser");
      mock.addPage(space, { url: "https://login.example/" });
      space.handBackReloaded = ["p1", "p3"];
      const task = await takeOverTaskSpace(space.id);
      assert.deepEqual(task.handBack, { reloaded: ["p1", "p3"] });
      assert.ok(Object.isFrozen(task.handBack!.reloaded));
      assert.equal((await takeOverTaskSpace(space.id)).handBack, undefined, "reported once");

      const waiting = await taskSpace(space.id);
      space.handBackReloaded = ["p1"];
      space.handBackOpenerCut = true;
      await waiting.waitForControl({ timeout: 1000 });
      assert.deepEqual(waiting.handBack, { openerCut: true, reloaded: ["p1"] });

      for (const odd of [[], [1], "p1"]) {
        const other = await taskSpace(space.id);
        space.handBackReloaded = odd;
        await other.waitForControl({ timeout: 1000 });
        assert.equal(other.handBack, undefined, `not a list of labels: ${JSON.stringify(odd)}`);
      }
    }));

  it("lists the Pages zenius blanked after a secret hand-off, once", () =>
    withMock(async ({ mock }) => {
      const space = mock.addSpace("token", "agentDelegatedToUser");
      mock.addPage(space, { url: "https://dash.example/tokens/new" });
      space.handBackBlanked = ["p1"];
      space.handBackReloaded = ["p2"];
      const task = await takeOverTaskSpace(space.id);
      assert.deepEqual(task.handBack, { reloaded: ["p2"], blanked: ["p1"] });
      assert.ok(Object.isFrozen(task.handBack!.blanked));
      assert.equal((await takeOverTaskSpace(space.id)).handBack, undefined, "reported once");

      const waiting = await taskSpace(space.id);
      space.handBackBlanked = ["p1", "p4"];
      await waiting.waitForControl({ timeout: 1000 });
      assert.deepEqual(waiting.handBack, { blanked: ["p1", "p4"] });
    }));
});

describe("TaskSpace", () => {
  it("pages(), tabs(), newPage(), adopt() and release() map to the page ledger", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("ledger");
      const space = mock.spaces.get(task.id)!;
      mock.addPage(space, { managed: false, url: "https://user.example/", title: "User tab", openedBy: "user" });
      const tabs = await task.tabs();
      assert.equal(tabs.length, 2);
      assert.deepEqual(Object.keys(tabs[0]!), ["targetId", "label", "page", "title", "url", "active", "openedBy"]);
      assert.deepEqual(Object.keys(tabs[1]!), ["targetId", "page", "title", "url", "active", "openedBy"]);
      assert.ok(tabs[0]!.page instanceof Page);
      assert.ok(tabs[1]!.page instanceof UnmanagedPage);
      assert.equal((tabs[0]!.page as Page).targetId, tabs[0]!.targetId);

      const pages = await task.pages();
      assert.deepEqual(
        pages.map((page) => page.label),
        ["p1"],
      );
      const p2 = await task.newPage();
      assert.equal(p2.label, "p2");
      assert.equal(p2.openedBy, "agent");
      await assert.rejects(() => task.newPage("https://x" as never), /does not accept arguments/);

      const adopted = await task.adopt(tabs[1]!.page as UnmanagedPage, { as: "user" });
      assert.equal(adopted.label, "user");
      const released = await task.release("user");
      assert.ok(released instanceof UnmanagedPage);
      assert.equal(released.openedBy, "user");
      await assert.rejects(() => task.release("p2"), /close it instead of releasing it/);

      // Closed groups: a tab and its popup go to the user together or not at all.
      mock.addPage(space, { url: "https://user.example/a", title: "Opener", openedBy: "unknown", label: "opener" });
      mock.addPage(space, { url: "https://user.example/b", title: "Popup", openedBy: "unknown", label: "popup", opener: "opener" });
      await assert.rejects(
        () => task.release("opener"),
        (error: ZeniusError) => {
          assert.equal(error.code, "ZEN_PAGE_GROUP_SHARED");
          assert.deepEqual(error.data?.pages, ["popup"]);
          assert.match(error.message, /^task\.release: .*group: true/);
          return true;
        },
      );
      await assert.rejects(() => task.release("opener", { group: "yes" } as never), /group/);
      const group = await task.release("opener", { group: true });
      assert.ok(group instanceof UnmanagedPage);
      assert.equal(group.openedBy, "unknown");
      assert.deepEqual(
        (await task.pages()).map((page) => page.label),
        ["p1", "p2"],
      );
      await assert.rejects(() => task.adopt({ targetId: "x" } as never), /requires an untracked page returned by task.tabs\(\)/);
    }));

  it("finish({ keep: [] }) closes the space and later Page use explains why it fails", () =>
    withMock(async () => {
      const task = await taskSpace("done");
      const receipt = await task.finish({ keep: [] });
      assert.deepEqual(receipt, {
        spaceId: task.id,
        closedSpace: true,
        keptManagedLabels: [],
        closedManagedLabels: ["p1"],
        preservedUnmanagedCount: 0,
      });
      await assert.rejects(() => task.finish(undefined as never), /options must be an object/);
      await assert.rejects(() => task.finish({} as never), /requires the keep option/);
    }));

  it("finish({ keep: [] }) with a user tab left open says the space now belongs to the user", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("shared");
      mock.addPage(mock.spaces.get(task.id)!, { managed: false, openedBy: "user", url: "https://user.example/" });
      const receipt = await task.finish({ keep: [] });
      assert.equal(receipt.closedSpace, false);
      assert.match(captureFlush(), /\[zenius\] finish\(\{ keep: \[\] \}\) did not close task space \d+: 1 tab\(s\) of user or unknown origin stayed open/);
    }));

  it("finish validates keep and passes \"all\" through", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("keep");
      await assert.rejects(() => task.finish({ keep: ["p1", "p1"] }), /must be "all" or an array of unique non-empty Page labels/);
      const receipt = await task.finish({ keep: "all" });
      assert.deepEqual(mock.requests.at(-1)?.params, { space: task.id, keep: "all" });
      assert.deepEqual(receipt.keptManagedLabels, ["p1"]);
    }));

  it("waitForControl and handOff map to the space methods", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("control");
      await task.waitForControl({ interval: 50, timeout: 1000 });
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.waitForControl")?.params, { space: task.id, interval: 50, timeout: 1000 });
      await assert.rejects(() => task.waitForControl({ timeout: -1 }), /timeout must be a positive number of milliseconds/);
      await task.handOff();
      assert.equal(mock.spaces.get(task.id)!.ownership, "agentDelegatedToUser");
    }));

  it("handOff({ message }) shows the message on the hold card, and taking the task back clears it", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("message");
      await task.handOff({ message: "  Sign in at 10.0.0.1 " });
      const space = mock.spaces.get(task.id)!;
      assert.deepEqual(
        mock.requests.slice(-2).map((request) => [request.method, request.params.text]),
        [["spaces.setState", "Sign in at 10.0.0.1"], ["spaces.handOff", undefined]],
        "the card's text is set while the task is still the agent's",
      );
      assert.equal(space.ownership, "agentDelegatedToUser");
      assert.equal(space.stateText, "Sign in at 10.0.0.1");

      await takeOverTaskSpace(task.id);
      assert.equal(space.stateText, "", "the message mustn't stay as the agent's progress text");

      // A hand-off without a message sends no text, and waitForControl clears it too.
      const before = mock.requests.length;
      await task.handOff();
      assert.deepEqual(mock.requests.slice(before).map((request) => request.method), ["spaces.handOff"]);
      space.stateText = "Sign in at 10.0.0.1";
      space.ownership = "agent";
      await task.waitForControl({ timeout: 1000 });
      assert.equal(space.stateText, "");
    }));

  it("handOff({ secret: true }) asks zenius to blank the tab at the hand back, and sends nothing for false", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("secret");
      await task.handOff({ message: "Create the token, copy it, then press Resume agent", secret: true });
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.handOff")!.params, { space: task.id, secret: true });
      mock.spaces.get(task.id)!.ownership = "agent";
      await task.handOff({ secret: false });
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.handOff")!.params, { space: task.id });
    }));

  it("handOff({ reason }) passes the reason on, refuses another before anything reaches the runtime, and sends none without one", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("reason");
      await task.handOff({ message: "Sign in to Accounts", reason: "sign_in" });
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.handOff")!.params, { space: task.id, reason: "sign_in" });
      mock.spaces.get(task.id)!.ownership = "agent";
      await task.handOff({ secret: true, reason: "irreversible" });
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.handOff")!.params, { space: task.id, secret: true, reason: "irreversible" });
      mock.spaces.get(task.id)!.ownership = "agent";

      const before = mock.requests.length;
      await assert.rejects(
        () => task.handOff({ message: "Sign in", reason: "login" as never }),
        (error: unknown) =>
          error instanceof TypeError &&
          error.message ===
            "task.handOff reason must be one of sign_in, irreversible, human_check, other. Expected: await task.handOff({ message?, secret?, reason? })",
      );
      assert.equal(mock.requests.length, before, "nothing reaches the runtime, not even the message");

      await task.handOff({ message: "Check the total" });
      assert.deepEqual(mock.requests.findLast((request) => request.method === "spaces.handOff")!.params, { space: task.id });
    }));

  it("a refused hand-off takes its message back off the card, and a message must name the step", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("refused");
      const space = mock.spaces.get(task.id)!;
      space.refuseHandOff = "reloadFailed";
      await assert.rejects(() => task.handOff({ message: "Open 192.168.1.10" }), (error: any) => error.code === "ZEN_HANDOFF_REFUSED");
      assert.equal(space.ownership, "agent");
      assert.equal(space.stateText, "");
      delete space.refuseHandOff;

      const before = mock.requests.length;
      await assert.rejects(() => task.handOff({ message: "   " }), /task\.handOff message must name the step/);
      await assert.rejects(() => task.handOff({ message: 42 as unknown as string }), /message/);
      await assert.rejects(() => task.handOff({ note: "x" } as never), /unknown option: note/);
      await assert.rejects(() => task.handOff({ secret: "yes" } as never), /secret/);
      assert.equal(mock.requests.length, before, "nothing reaches the runtime");
      assert.equal(space.ownership, "agent");
    }));

  it("EGO_BROWSER_PAGE_BUDGET caps a space's managed Pages for this process, as in Ego", () =>
    withEnv({ EGO_BROWSER_PAGE_BUDGET: "2" }, () =>
      withMock(async ({ mock }) => {
        const task = await taskSpace("budget");
        await task.newPage();
        await assert.rejects(
          () => task.newPage(),
          (error: any) =>
            error.code === "ZEN_PAGE_BUDGET_REACHED" && error.budget === 2 && /^task\.newPage: Page budget reached \(2\/2\) in space "budget"\./.test(error.message),
        );
        // adopt() counts too: an untracked tab can't become a third Page.
        const stray = mock.addPage(mock.spaces.get(task.id)!, { managed: false, openedBy: "user" });
        const untracked = (await task.tabs()).find((tab) => tab.targetId === stray.tab)!.page as UnmanagedPage;
        await assert.rejects(() => task.adopt(untracked), (error: any) => error.code === "ZEN_PAGE_BUDGET_REACHED");
        await task.page("p2").close();
        assert.equal((await task.adopt(untracked)).label, "p3");
      }),
    ));

  it("cdp() is unsupported with guidance", () =>
    withMock(async () => {
      const task = await taskSpace("cdp");
      await assert.rejects(
        () => task.cdp("Target.getTargets"),
        (error: any) => error.code === "ZEN_UNSUPPORTED" && /page\.evaluate\(\)/.test(error.message),
      );
      await assert.rejects(
        () => task.page("p1").cdp("Runtime.evaluate", {}),
        (error: any) => error.code === "ZEN_UNSUPPORTED" && /page\.events\(\) always has the console messages/.test(error.message),
      );
    }));

  it("page.cdp() console toggles from Ego's skill resolve and do nothing: events() always has console messages", () =>
    withMock(async ({ mock }) => {
      const page = (await taskSpace("cdp console")).page("p1");
      const before = mock.requests.length;
      // Ego's skill: turn off its CDP hiding, then enable the Runtime domain.
      assert.deepEqual(await page.cdp("egoAutomated.disable"), {});
      assert.deepEqual(await page.cdp("Runtime.enable"), {});
      assert.deepEqual(await page.cdp("Runtime.disable"), {});
      assert.deepEqual(await page.cdp("egoAutomated.enable"), {});
      assert.equal(mock.requests.length, before, "no request: there is nothing to switch");
      await assert.rejects(() => page.cdp("Runtime.evaluate", { expression: "1" }), (error: any) => error.code === "ZEN_UNSUPPORTED");
      await assert.rejects(() => page.cdp("Log.enable"), (error: any) => error.code === "ZEN_UNSUPPORTED");
    }));
});

describe("Page", () => {
  it("receipts keep refused, and events() keeps Zenius.refused, as the runtime sends them", () =>
    withMock(async ({ mock }) => {
      const refusal = { kind: "print", message: "The page called window.print()." };
      mock.handle("page.click", () => ({ refused: [refusal] }));
      mock.handle("page.events", () => ({ events: [{ method: "Zenius.refused", params: { ...refusal, url: "http://127.0.0.1/x" } }] }));
      const page = (await taskSpace("refusals")).page("p1");
      assert.deepEqual((await page.click("#print")).refused, [refusal]);
      const refused = (await page.events()).filter((event): event is RefusedEvent => event.method === "Zenius.refused");
      assert.deepEqual(refused.map((event) => [event.params.kind, event.params.url]), [["print", "http://127.0.0.1/x"]]);
    }));

  // The agent's own evidence for zenius's defenses: zen-core's page.flag marks
  // the page's current document as flagged.
  it("flag(reason) asks zenius to guard the page, sends only the reason, and leaves its rules to the runtime", () =>
    withMock(async ({ mock }) => {
      mock.handle("page.flag", () => ({ ok: true }));
      const task = await taskSpace("flagged");
      const page = task.page("p1");
      assert.equal(await page.flag("It asks for a card number the task didn't call for"), undefined);
      const sent = mock.requests.findLast((request) => request.method === "page.flag")!.params;
      assert.deepEqual([sent.space, sent.page, sent.reason], [task.id, "p1", "It asks for a card number the task didn't call for"]);
      const count = mock.requests.length;
      for (const reason of [undefined, 42, { reason: "x" }]) {
        await assert.rejects(() => page.flag(reason as never), (error: any) => error instanceof TypeError && error.message === "page.flag reason must be a string");
      }
      assert.equal(mock.requests.length, count, "no request for a reason that isn't text");
      mock.handle("page.flag", () => {
        throw new MockError("ZEN_INVALID_ARGUMENT", "the reason is 1 to 200 characters on one line");
      });
      await assert.rejects(() => page.flag(""), (error: any) => error.code === "ZEN_INVALID_ARGUMENT" && /^page\.flag: /.test(error.message));
    }));

  it("task.page(label) is lazy and makes no request", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("lazy");
      const count = mock.requests.length;
      const page = task.page("p9");
      assert.equal(page.label, "p9");
      assert.equal(page.spaceId, task.id);
      assert.equal(page.targetId, undefined);
      assert.equal(mock.requests.length, count);
      await assert.rejects(
        () => page.url(),
        (error: any) =>
          error.code === "ZEN_PAGE_NOT_FOUND" &&
          /Managed Pages in task space \d+: p1/.test(error.message) &&
          /create one with await task.newPage\(\)/.test(error.message),
      );
    }));

  it("navigation, observation and actions send one request each with Ego's parameters", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("actions");
      const page = task.page("p1");
      const space = task.id;
      const start = mock.requests.length;

      assert.deepEqual(await page.goto("https://example.com/", { waitUntil: "domcontentloaded" }), {});
      assert.equal(await page.url(), "https://example.com/");
      assert.equal(await page.title(), "Title of https://example.com/");
      assert.match(await page.snapshot(), /^\[p1 "Title of https:\/\/example.com\/" \| space "actions"/);
      assert.deepEqual(await page.click("@2", { label: "sign in" }), {});
      await page.fill("#email", "a@b.c", { clearFirst: false });
      await page.press("#email", "ControlOrMeta+a");
      assert.deepEqual(await page.selectOption("select", [{ label: "October" }, "b"]), ["October", "b"]);
      await page.mouse.click(10, 20, { label: "cell" });
      await page.mouse.move(30, 40, { steps: 5 });
      await page.mouse.down({ button: "left" });
      await page.mouse.up();
      await page.mouse.wheel(0, 600);
      await page.keyboard.press("Enter");
      await page.keyboard.type("hello", { delay: 5 });
      await page.keyboard.insertText("plain");
      await page.keyboard.paste({ text: "t", html: "<b>t</b>" });
      await page.keyboard.down("Shift");
      await page.keyboard.up("Shift");
      await page.dragAndDrop("#a", "#b", { sourcePosition: { x: 1, y: 2 } });

      const sent = mock.requests.slice(start).map((request) => [request.method, request.params]);
      assert.deepEqual(sent, [
        ["page.goto", { space, page: "p1", url: "https://example.com/", options: { waitUntil: "domcontentloaded" } }],
        ["page.url", { space, page: "p1" }],
        ["page.title", { space, page: "p1" }],
        ["page.snapshot", { space, page: "p1", options: {} }],
        ["page.click", { space, page: "p1", target: "@2", options: { label: "sign in" } }],
        ["page.fill", { space, page: "p1", target: "#email", value: "a@b.c", options: { clearFirst: false } }],
        ["page.press", { space, page: "p1", target: "#email", chord: "ControlOrMeta+a", options: {} }],
        ["page.selectOption", { space, page: "p1", target: "select", values: [{ label: "October" }, "b"], options: {} }],
        ["page.mouse", { space, page: "p1", action: "click", x: 10, y: 20, options: { label: "cell" } }],
        ["page.mouse", { space, page: "p1", action: "move", x: 30, y: 40, options: { steps: 5 } }],
        ["page.mouse", { space, page: "p1", action: "down", options: { button: "left" } }],
        ["page.mouse", { space, page: "p1", action: "up", options: {} }],
        ["page.mouse", { space, page: "p1", action: "wheel", dx: 0, dy: 600, options: {} }],
        ["page.keyboard", { space, page: "p1", action: "press", key: "Enter", options: {} }],
        ["page.keyboard", { space, page: "p1", action: "type", text: "hello", options: { delay: 5 } }],
        ["page.keyboard", { space, page: "p1", action: "insertText", text: "plain" }],
        ["page.keyboard", { space, page: "p1", action: "paste", text: "t", html: "<b>t</b>" }],
        ["page.keyboard", { space, page: "p1", action: "down", key: "Shift" }],
        ["page.keyboard", { space, page: "p1", action: "up", key: "Shift" }],
        ["page.dragAndDrop", { space, page: "p1", source: "#a", target: "#b", options: { sourcePosition: { x: 1, y: 2 } } }],
      ]);
    }));

  it("gives an action's client limit room for its delay: Ego cuts nothing on the client", () => {
    // The timeout plus 10 s of grace (60 s without one), plus each pause options.delay makes.
    assert.equal(clientLimitMs({ timeout: 1000, delay: 15_000 }, 1), 1000 + 10_000 + 15_000);
    assert.equal(clientLimitMs({ delay: 100 }, 4), 60_000 + 400);
    assert.equal(clientLimitMs({ timeout: 500 }), 10_500);
  });

  it("argument validation matches Ego and happens before any request", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("validation");
      const page = task.page("p1");
      const start = mock.requests.length;
      const cases: Array<[() => Promise<unknown>, RegExp]> = [
        [() => page.goto(""), /page URL must be a non-empty string/],
        [() => page.goto("https://x", { waitUntil: "idle" }), /page.goto waitUntil must be one of commit, domcontentloaded, load, networkidle/],
        [() => page.click(""), /Page actions require a non-empty selector string/],
        [() => page.click("#a", { label: "" }), /page.click label must be a non-empty string/],
        [() => page.fill("#a", "x", { label: "typing" } as never), /page.fill received unknown option: label. Expected: await page.fill/],
        [() => page.fill("#a", 5 as never), /page.fill value must be a string/],
        // Ego checks options before the selector, and page.press's chord in keyboard.press's words.
        [() => page.click("", { foo: 1 } as never), /^TypeError: page\.click received unknown option: foo/],
        [() => page.press("#a", "Control+"), /^TypeError: page\.keyboard\.press received invalid chord: Control\+$/],
        [() => page.press("#a", ""), /^TypeError: page\.keyboard\.press requires a non-empty key$/],
        // Ego looks every key up: an empty one is just unknown, and a plain Error.
        [() => page.keyboard.down(""), /^Error: Unknown key: ""$/],
        [() => page.keyboard.up(""), /^Error: Unknown key: ""$/],
        [() => page.click("#a", { position: { x: 1 } }), /position must be point/],
        [() => page.click("#a", { clickCount: 0 }), /clickCount must be a positive integer/],
        [() => page.screenshot({ path: "relative.png" }), /page.screenshot path must be an absolute file path/],
        [() => page.screenshot({ clip: { x: 0, y: 0, width: 0, height: 1 } }), /clip must be clip/],
        [() => page.setInputFiles("input", "relative.txt"), /requires absolute file paths/],
        [() => page.snapshot({ scope: "subtree" }), /subtree scope requires root/],
        [() => page.snapshot({ root: "@2" }), /root is only supported when scope is subtree/],
        [() => page.snapshot({ scope: "subtree", root: "two" }), /root must be a snapshot ref/],
        [() => page.evaluate(42 as never), /expects a function or string expression/],
        [() => page.evaluate("1 + 1", 2), /string expression does not accept an argument/],
        [() => page.evaluate((value: unknown) => value, { n: 1n }), /argument must be JSON-serializable/],
        [() => page.evaluate((value: unknown) => value, undefined), /argument must be JSON-serializable/],
        [() => page.waitForFunction(() => true, { timeout: 5 }), /options are the third argument/],
        [() => page.waitForLoadState("idle"), /supports only "domcontentloaded", "load", and "networkidle"/],
        [() => page.waitForSelector(""), /selector must be a non-empty string/],
        [() => page.waitForTimeout(-1), /non-negative number of milliseconds/],
        [() => page.waitForURL(""), /expected URL must be a non-empty string, RegExp, or function/],
        [() => page.waitForURL("https://x/{a,b"), /Invalid URL glob "https:\/\/x\/\{a,b": unmatched '\{'/],
        [() => page.selectOption("s", [{ value: 1 }]), /valueOrValues\[0\]\.value must be a string/],
        [() => page.selectOption("s", { nth: 1 }), /has unknown field "nth"/],
        [() => page.keyboard.paste(["x"]), /requires a string or \{ text, html\? \}, received an array/],
        [() => page.keyboard.type(5 as never), /page.keyboard.type text must be a string/],
        [() => page.mouse.click(Number.NaN, 1), /requires finite x and y coordinates/],
        [() => page.mouse.wheel(0, Infinity), /requires finite deltaX and deltaY/],
        [() => page.fetch("/x", { saveAs: "out.bin" }), /page.fetch saveAs must be an absolute file path/],
        [() => page.fetch("/x", { headers: { a: 1 } } as never), /headers must be an object with string values/],
        [() => page.acceptDialog(5 as never), /promptText must be a string/],
      ];
      for (const [call, pattern] of cases) await assert.rejects(call, pattern);
      assert.throws(() => page.waitForEvent("load" as never), /only supports the popup and download events/);
      assert.equal(mock.requests.length, start, "no request reached the runtime");
    }));

  it("errors the runtime marks plain reach the script as Ego's plain Error, without a code", () =>
    withMock(async ({ mock }) => {
      const message = "JavaScript evaluation failed at line 1, column 7: ReferenceError: nodeOnly is not defined; expression: () => nodeOnly";
      mock.handle("page.evaluate", () => {
        throw new MockError("ZEN_EVALUATION_FAILED", message, { plain: true });
      });
      const page = (await taskSpace("plain errors")).page("p1");
      await assert.rejects(page.evaluate("nodeOnly"), (error: Error & { code?: unknown }) => {
        assert.equal(error.constructor, Error);
        assert.equal(error.code, undefined);
        // Ego's text first, then what to do next on a line of its own.
        assert.equal(error.message, `${message}\nFix the code that ran in the page: the error above is the page's own.`);
        return true;
      });
      // The Node-versus-Page hint still applies to callbacks.
      await assert.rejects(
        page.evaluate(() => 1),
        /^Error: JavaScript evaluation failed .*\npage\.evaluate\(\) callbacks run inside the Page and cannot access variables from the Node\.js script/,
      );
    }));

  it("sends EGO_BROWSER_RESPONSE_TIMEOUT_MS as responseTimeout on Page calls, read per call", () =>
    withMock(async ({ mock }) => {
      const page = (await taskSpace("response timeout")).page("p1");
      const last = () => mock.requests.at(-1)!.params.responseTimeout;
      const previous = process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS;
      try {
        for (const [value, expected] of [["4000", 4000], ["abc", undefined], ["0", undefined], ["1.5", undefined]] as const) {
          process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS = value;
          await page.evaluate("1");
          assert.equal(last(), expected, value);
        }
        delete process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS;
        await page.goto("https://example.com/");
        assert.equal(last(), undefined);
      } finally {
        if (previous === undefined) delete process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS;
        else process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS = previous;
      }
    }));

  it("evaluate returns NaN, ±Infinity, -0 and BigInt as Ego does", () =>
    withMock(async () => {
      const page = (await taskSpace("unserializable")).page("p1");
      assert.ok(Number.isNaN(await page.evaluate(() => NaN)));
      assert.equal(await page.evaluate(() => -Infinity), -Infinity);
      assert.ok(Object.is(await page.evaluate(() => -0), -0));
      assert.equal(await page.evaluate("2n ** 70n"), 2n ** 70n);
      assert.deepEqual(await page.evaluate(() => ({ nested: NaN })), { nested: null });
    }));

  it("evaluate sends the source, and arg only when the caller passed one", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("evaluate");
      const page = task.page("p1");
      await page.goto("https://example.com/path");
      assert.equal(await page.evaluate(() => location.href), "https://example.com/path");
      assert.equal("arg" in mock.requests.at(-1)!.params, false);
      assert.equal(await page.evaluate(({ a, b }: { a: number; b: number }) => a + b, { a: 2, b: 3 }), 5);
      assert.deepEqual(mock.requests.at(-1)!.params.arg, { a: 2, b: 3 });
      assert.equal(await page.evaluate("document.title"), "Title of https://example.com/path");
      assert.equal(mock.requests.at(-1)!.params.isFunction, false);
      assert.equal(await page.evaluate(() => undefined), null);
      await assert.rejects(
        () => page.evaluate(() => nodeOnlyVariable + 1),
        /callbacks run inside the Page and cannot access variables from the Node.js script/,
      );
      assert.equal(await page.waitForFunction(() => true), true);
      assert.equal(await page.waitForFunction((n: number) => n > 1, 2, { timeout: 500, polling: 50 }), true);
      assert.deepEqual(mock.requests.at(-1)!.params.options, { timeout: 500, polling: 50 });
      assert.equal(await page.waitForFunction("true", undefined, { timeout: 500 }), true);
      assert.equal("arg" in mock.requests.at(-1)!.params, false);
    }));

  it("waitForURL sends globs compiled to a regex, regexes as source and flags, and polls predicates", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("urls");
      const page = task.page("p1");
      await page.goto("https://example.com/a/b?q=1");
      await page.waitForURL("https://example.com/**");
      assert.deepEqual(mock.requests.at(-1)!.params.matcher, {
        type: "glob",
        value: "https://example.com/**",
        regex: "^https:\\/\\/example\\.com\\/.*$",
      });
      await page.waitForURL(/example\.com\/a/i, { timeout: 100 });
      assert.deepEqual(mock.requests.at(-1)!.params.matcher, { type: "regex", value: "example\\.com\\/a", flags: "i" });
      await page.waitForURL((url: URL) => url.searchParams.get("q") === "1");
      assert.equal(mock.requests.at(-1)!.method, "page.url");
      // A poll never waits for a pending navigation (zen-observe's runtime).
      assert.equal(mock.requests.at(-1)!.params.poll, true);
      await assert.rejects(
        () => page.waitForURL((url: URL) => url.pathname === "/never", { timeout: 250 }),
        (error: any) => error.code === "ZEN_TIMEOUT" && /expected a URL predicate; last URL was "https:\/\/example.com\/a\/b\?q=1"/.test(error.message),
      );
      await assert.rejects(
        () => page.waitForURL((url: any) => url.includes("x")),
        /The predicate receives a URL object/,
      );
      await assert.rejects(() => page.waitForURL(() => "yes" as never), /must return a boolean synchronously/);
    }));

  it("popup waits are armed before the action that opens the popup", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("popups");
      const page = task.page("p1");
      const pending = page.waitForEvent("popup");
      const receipt = await page.click("a.popup");
      const popup = (await pending) as Page;
      assert.ok(popup instanceof Page);
      assert.equal(popup.label, "p2");
      assert.match(String(popup.targetId), /^tab-/);
      assert.deepEqual(receipt.popups?.map((entry) => entry.label), ["p2"]);
      const order = mock.methods();
      assert.ok(order.indexOf("page.waitForEvent") < order.indexOf("page.click"));
    }));

  it("download.saveAs returns the file's absolute path, and nothing lists it outside the sandbox", () =>
    withMock(async () => {
      const page = (await taskSpace("saved")).page("p1");
      const downloadPromise = page.waitForEvent("download", { timeout: 2000 });
      await page.click("button.download");
      const download: any = await downloadPromise;
      const dir = mkdtempSync(join(tmpdir(), "zenius-saved-"));
      try {
        assert.equal(await download.saveAs(join(dir, "report.pdf")), join(dir, "report.pdf"));
        assert.equal(await page.screenshot({ path: join(dir, "shot.png") }), join(dir, "shot.png"));
        const printed: string[] = [];
        flushOutput(false, (chunk) => printed.push(chunk));
        assert.doesNotMatch(printed.join(""), /zenius:files/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("downloads and file choosers resolve to objects with the synchronous accessors", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("files");
      const page = task.page("p1");
      const downloadPromise = page.waitForEvent("download", { timeout: 2000 });
      assert.throws(() => page.waitForEvent("download"), /already has an active download wait/);
      await page.click("button.download");
      const download: any = await downloadPromise;
      assert.equal(download.url(), "https://example.com/report.pdf");
      assert.equal(download.suggestedFilename(), "report.pdf");
      assert.equal(download.page(), page);
      const target = join(mock.dir, "nested", "..", "report.pdf");
      await download.saveAs(target);
      assert.equal(readFileSync(target, "utf8"), "download d1");
      await assert.rejects(() => download.saveAs("relative.pdf"), /download.saveAs requires an absolute file path/);
      assert.equal(await download.failure(), null);
      const copy = await download.path();
      assert.match(copy, /\/zenius-downloads-[^/]+\/d1\/report\.pdf$/);
      assert.equal(readFileSync(copy, "utf8"), "download d1");
      assert.equal(await download.path(), copy, "path() writes one copy");
      assert.ok(!mock.methods().some((method) => method === "download.saveAs" || method === "download.path"), "no path goes to the runtime");

      const chooserPromise = page.waitForFileChooser({ timeout: 2000 });
      assert.throws(() => page.waitForFileChooser(), /already waiting for a file chooser/);
      await page.click("button.upload");
      const chooser = await chooserPromise;
      assert.equal(chooser.isMultiple(), true);
      const a = join(mock.dir, "a.txt");
      const b = join(mock.dir, "b.txt");
      writeFileSync(a, "file a");
      writeFileSync(b, "file b");
      // A file that can't be read leaves the chooser open for the next call.
      await assert.rejects(() => chooser.setFiles(join(mock.dir, "missing.txt")), /could not read .*missing\.txt: no such file/);
      assert.deepEqual(await chooser.setFiles([a, b]), {});
      assert.deepEqual(mock.requests.at(-1)!.params, {
        chooser: "c1",
        files: [payload(a, "file a"), payload(b, "file b")],
      });
      await assert.rejects(() => chooser.setFiles(a), /already handled/);
    }));

  it("downloads: the CLI writes every copy from the runtime's bytes, in chunks", () =>
    withMock(async ({ mock, round }) => {
      const page = (await taskSpace("download bytes")).page("p1");
      const big = Buffer.alloc(8 * 1024 * 1024 + 100, 7);
      big.write("first", 0);
      big.write("last", big.length - 4);
      mock.downloadBodies.set("d1", big);
      const [download] = (await Promise.all([page.waitForEvent("download"), page.click("a.download")])) as [Download, unknown];
      const target = join(mock.dir, "deep", "big.bin");
      await download.saveAs(target);
      assert.ok(readFileSync(target).equals(big));
      assert.deepEqual(
        mock.requests.filter((request) => request.method === "download.read").map((request) => [request.params.offset, request.params.length]),
        [[0, 8 * 1024 * 1024], [8 * 1024 * 1024, 8 * 1024 * 1024]],
      );
      const copy = await download.path();
      assert.ok(readFileSync(copy).equals(big));
      await download.delete();
      assert.equal(existsSync(copy), false, "delete() removes the copy");

      // A failed transfer leaves a file already at the target alone.
      mock.failingDownloads.add("d2");
      const [failed] = (await Promise.all([page.waitForEvent("download"), page.click("a.download")])) as [Download, unknown];
      writeFileSync(target, "kept");
      await assert.rejects(() => failed.saveAs(target), (error: ZeniusError) => error.code === "ZEN_DOWNLOAD_FAILED");
      assert.equal(readFileSync(target, "utf8"), "kept");
      await assert.rejects(() => failed.path(), (error: ZeniusError) => error.code === "ZEN_DOWNLOAD_FAILED");

      // The run's copies go when the script ends.
      const [third] = (await Promise.all([page.waitForEvent("download"), page.click("a.download")])) as [Download, unknown];
      const left = await third.path();
      await round.disposeDownloads();
      assert.equal(existsSync(left), false);
    }));

  it("screenshots, saved bodies and downloads are new files only the user can read", () =>
    withMock(async ({ mock, round }) => {
      const page = (await taskSpace("private files")).page("p1");
      const mode = (file: string) => statSync(file).mode & 0o777;
      // The default one lands in the system's temporary folder, shared on Linux.
      const shot = await page.screenshot();
      try {
        assert.equal(mode(shot), 0o600);
      } finally {
        rmSync(shot, { force: true });
      }
      const named = join(mock.dir, "shots", "named.png");
      await page.screenshot({ path: named });
      assert.equal(mode(named), 0o600);
      const body = join(mock.dir, "fetched", "body.bin");
      await page.fetch("/file", { saveAs: body });
      assert.equal(mode(body), 0o600);
      mock.downloadBodies.set("d1", Buffer.from("downloaded"));
      const [download] = (await Promise.all([page.waitForEvent("download"), page.click("a.download")])) as [Download, unknown];
      const target = join(mock.dir, "downloads", "file.bin");
      await download.saveAs(target);
      assert.equal(mode(target), 0o600);
      assert.equal(mode(await download.path()), 0o600, "the run's own copy");
      await round.disposeDownloads();
    }));

  // With I5 the CLI does the file I/O, so a sandbox around it covers uploads.
  it("under node --permission, an upload outside the grants fails in the CLI with a clear message", { skip: !process.allowedNodeEnvironmentFlags.has("--permission") }, () => {
    const sdk = fileURLToPath(new URL("..", import.meta.url));
    // Real paths, as the launcher grants them (the Mac's temporary folder is under a link).
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "zenius-outside-")));
    const granted = realpathSync(mkdtempSync(join(tmpdir(), "zenius-granted-")));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    writeFileSync(join(granted, "mine.txt"), "mine");
    symlinkSync(join(granted, "mine.txt"), join(granted, "alias.txt"));
    symlinkSync(secret, join(granted, "link.txt"));
    symlinkSync(outside, join(granted, "folder"));
    const upload = (file: string) => {
      const script = `const { readUploads } = await import(${JSON.stringify(pathToFileURL(join(sdk, "src", "files.ts")).href)});
try { console.log("sent", (await readUploads([${JSON.stringify(file)}], "page.setInputFiles")).map((upload) => Buffer.from(upload.base64, "base64").toString()).join()); } catch (error) { console.log(error.code, error.message); }`;
      const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${sdk}`, `--allow-fs-read=${granted}`, "--input-type=module", "-e", script], {
        encoding: "utf8",
      });
      return result.stdout.trim() || result.stderr;
    };
    const refusal = (where: string) =>
      `ZEN_PATH_NOT_ALLOWED page.setInputFiles: a sandboxed script reads files only in its working folder, its runs' output folders and its temporary folder, and ${where}. If the task needs this file, ask the user to copy it into the working folder.`;
    try {
      assert.equal(upload(secret), refusal(`${secret} is outside them`));
      // Node's permission model follows a link anywhere, so the CLI checks where it leads.
      assert.equal(upload(join(granted, "link.txt")), refusal(`${join(granted, "link.txt")} leads outside them, to ${secret}`));
      assert.equal(upload(join(granted, "folder", "secret.txt")), refusal(`${join(granted, "folder", "secret.txt")} leads outside them, to ${secret}`));
      assert.equal(upload(join(granted, "alias.txt")), "sent mine");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(granted, { recursive: true, force: true });
    }
  });

  // install-cli.sh --sandbox --read-dir (the user's ~/Downloads): the launcher
  // grants the folder and names it in ZENIUS_READ_DIR, for the messages.
  it("under node --permission, the install's read folder uploads, and a refusal names it", { skip: !process.allowedNodeEnvironmentFlags.has("--permission") }, () => {
    const sdk = fileURLToPath(new URL("..", import.meta.url));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "zenius-outside-")));
    const downloads = realpathSync(mkdtempSync(join(tmpdir(), "zenius-downloads-")));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    writeFileSync(join(downloads, "report.txt"), "report");
    symlinkSync(secret, join(downloads, "link.txt"));
    const upload = (file: string, readDir: string | undefined) => {
      const script = `const { readUploads } = await import(${JSON.stringify(pathToFileURL(join(sdk, "src", "files.ts")).href)});
try { console.log("sent", (await readUploads([${JSON.stringify(file)}], "page.setInputFiles")).map((upload) => Buffer.from(upload.base64, "base64").toString()).join()); } catch (error) { console.log(error.code, error.message); }`;
      const env: Record<string, string | undefined> = { ...process.env, ZENIUS_READ_DIR: readDir };
      if (readDir === undefined) delete env.ZENIUS_READ_DIR;
      const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${sdk}`, `--allow-fs-read=${downloads}`, "--input-type=module", "-e", script], {
        encoding: "utf8",
        env,
      });
      return result.stdout.trim() || result.stderr;
    };
    const refusal = (where: string) =>
      `ZEN_PATH_NOT_ALLOWED page.setInputFiles: a sandboxed script reads files only in its working folder, its runs' output folders, its temporary folder and ${downloads}, and ${where}. If the task needs this file, ask the user to copy it into the working folder or ${downloads}.`;
    try {
      assert.equal(upload(join(downloads, "report.txt"), downloads), "sent report");
      assert.equal(upload(secret, downloads), refusal(`${secret} is outside them`));
      assert.equal(upload(join(downloads, "link.txt"), downloads), refusal(`${join(downloads, "link.txt")} leads outside them, to ${secret}`));
      // A relative ZENIUS_READ_DIR isn't the launcher's: the message names no such folder.
      assert.match(upload(secret, "Downloads"), /its runs' output folders and its temporary folder, and /);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(downloads, { recursive: true, force: true });
    }
  });

  // SPEC I5: the browser never opens a path an agent names, so the CLI reads
  // the files and the runtime gets their contents.
  it("uploads send the files' contents, read in the CLI, never their paths", () =>
    withMock(async ({ mock }) => {
      const page = (await taskSpace("uploads")).page("p1");
      const notes = join(mock.dir, "notes.txt");
      const image = join(mock.dir, "pixel.png");
      writeFileSync(notes, "hello upload\n");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
      await page.setInputFiles("input", [notes, image]);
      assert.deepEqual(mock.requests.at(-1)!.params.files, [payload(notes, "hello upload\n"), payload(image)]);
      await page.setInputFiles("input", notes);
      assert.deepEqual(mock.requests.at(-1)!.params.files, [payload(notes, "hello upload\n")]);
      await page.setInputFiles("input", []);
      assert.deepEqual(mock.requests.at(-1)!.params.files, []);
      // A folder's path makes a folder upload: each file carries its path in the folder.
      const album = join(mock.dir, "album");
      mkdirSync(join(album, "2024"), { recursive: true });
      writeFileSync(join(album, "2024", "a.txt"), "ay");
      await page.setInputFiles("input", album);
      assert.deepEqual(mock.requests.at(-1)!.params.files, [{ ...payload(join(album, "2024", "a.txt"), "ay"), relativePath: "album/2024/a.txt" }]);

      const sent = mock.requests.length;
      const folder = join(mock.dir, "folder");
      mkdirSync(folder);
      const large = join(mock.dir, "large.bin");
      // Sparse, so the test writes nothing: the limit is checked before reading.
      writeFileSync(large, "");
      truncateSync(large, 50 * 1024 * 1024 + 1);
      const cases: Array<[string | string[], RegExp]> = [
        [join(mock.dir, "missing.txt"), /^page\.setInputFiles could not read .*missing\.txt: no such file\nFix the call: help\("page\.setInputFiles"\) prints its signature and options\.$/],
        [folder, /^page\.setInputFiles: .*folder holds no files, and a folder upload needs at least one\nFix the call: help\("page\.setInputFiles"\) prints its signature and options\.$/],
        [[folder, notes], /^page\.setInputFiles: .*folder is a folder, and a folder upload sends that one folder alone: pass only its path, with no other folder or file\nFix the call: /],
        ["/dev/null", /^page\.setInputFiles could not read \/dev\/null: it is not a regular file\nFix the call: help\("page\.setInputFiles"\) prints its signature and options\.$/],
        [[notes, large], /^page\.setInputFiles: the files total 52428814 bytes, over the limit of 52428800 \(50 MB\)\nFix the call: help\("page\.setInputFiles"\) prints its signature and options\.$/],
      ];
      if (process.getuid?.() !== 0) {
        const locked = join(mock.dir, "locked.txt");
        writeFileSync(locked, "secret");
        chmodSync(locked, 0o000);
        cases.push([locked, /^page\.setInputFiles could not read .*locked\.txt: permission denied\nFix the call: help\("page\.setInputFiles"\) prints its signature and options\.$/]);
      }
      for (const [files, message] of cases) {
        await assert.rejects(
          () => page.setInputFiles("input", files),
          (error: ZeniusError) => error.code === "ZEN_INVALID_ARGUMENT" && message.test(error.message),
          String(files),
        );
      }
      assert.equal(mock.requests.length, sent, "nothing is sent when a file can't be read");
    }));

  it("dialogs: receipts report them, accept and dismiss return false when none is open", () =>
    withMock(async () => {
      const task = await taskSpace("dialogs");
      const page = task.page("p1");
      const receipt = await page.click("#alert");
      assert.deepEqual(receipt.dialog, { type: "alert", message: "hello" });
      assert.deepEqual(await page.info(), { dialog: { type: "alert", message: "hello" } });
      assert.equal(await page.acceptDialog("answer"), true);
      assert.equal(await page.acceptDialog(), false);
      assert.equal(await page.dismissDialog(), false);
    }));

  it("fetch, screenshot, events and close", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("io");
      const page = task.page("p1");
      const response = await page.fetch("/api", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      assert.equal(response.body, "fetched /api");
      // The CLI writes the body and the PNG; the runtime never gets a path (SPEC I5).
      const saved = join(mock.dir, "fetched", "body.bin");
      const savedResponse = await page.fetch("/file", { saveAs: saved });
      assert.deepEqual(mock.requests.at(-1)!.params.options, { binary: true });
      assert.deepEqual(savedResponse, { ok: true, status: 200, statusText: "OK", url: "/file", headers: { "content-type": "text/plain" }, savedPath: saved });
      assert.equal(readFileSync(saved, "utf8"), "fetched /file");
      const shot = await page.screenshot();
      assert.match(shot, new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/zenius-shot-\\d{6}\\.png$`));
      assert.deepEqual(readFileSync(shot), MOCK_PNG);
      rmSync(shot, { force: true });
      const named = join(mock.dir, "shots", "full.png");
      assert.equal(await page.screenshot({ path: named, fullPage: true }), named);
      assert.deepEqual(mock.requests.at(-1)!.params.options, { fullPage: true });
      assert.deepEqual(readFileSync(named), MOCK_PNG);
      (globalThis as { EGO_BROWSER_OUTPUT_DIR?: unknown }).EGO_BROWSER_OUTPUT_DIR = mock.dir;
      try {
        assert.match(await page.screenshot(), new RegExp(`^${mock.dir}/zenius-shot-\\d{6}\\.png$`));
        (globalThis as { EGO_BROWSER_OUTPUT_DIR?: unknown }).EGO_BROWSER_OUTPUT_DIR = "relative/dir";
        await assert.rejects(page.screenshot(), /globalThis\.EGO_BROWSER_OUTPUT_DIR must be an absolute directory path/);
      } finally {
        delete (globalThis as { EGO_BROWSER_OUTPUT_DIR?: unknown }).EGO_BROWSER_OUTPUT_DIR;
      }
      assert.deepEqual(await page.events(), [{ type: "console", text: "hi" }]);
      const p2 = await task.newPage();
      await p2.close();
      assert.deepEqual(
        (await task.pages()).map((entry) => entry.label),
        ["p1"],
      );
    }));

  it("selector errors keep the runtime's code and name the failing call", () =>
    withMock(async () => {
      const task = await taskSpace("errors");
      const page = task.page("p1");
      await assert.rejects(
        () => page.click("#missing"),
        (error: any) =>
          error instanceof ZeniusError &&
          error.code === "ZEN_SELECTOR_NOT_FOUND" &&
          error.message.startsWith("page.click: selector"),
      );
      await assert.rejects(
        () => page.hover("#ambiguous"),
        (error: any) => error.code === "ZEN_SELECTOR_AMBIGUOUS" && error.matches === 3 && error.data.matches === 3,
      );
    }));
});

describe("hard stops", () => {
  it("user control discards the script's output and prints the takeover guidance once", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("takeover");
      mock.spaces.get(task.id)!.ownership = "agentDelegatedToUser";
      const { bufferOutput } = await import("../src/output.ts");
      bufferOutput("business output\n");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          () => task.page("p1").click("#go"),
          (error: any) =>
            error.code === "ZEN_TASK_SPACE_USER_IN_CONTROL" &&
            error.reason === "manual_takeover" &&
            error.message.startsWith("page.click: Control of this task space is with the user"),
        );
      }
      const out = captureFlush(false);
      assert.doesNotMatch(out, /business output/);
      assert.equal(out.match(/Control of this task space is with the user/g)?.length, 1);
      assert.match(out, /takeOverTaskSpace\(spaceId\)/);
    }));

  it("a permission prompt reason gets its own guidance", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("permission");
      const space = mock.spaces.get(task.id)!;
      space.ownership = "agentDelegatedToUser";
      space.reason = "camera";
      await assert.rejects(() => task.page("p1").goto("https://meet.example/"), /A browser permission prompt for camera access has appeared/);
    }));

  it("an ended task points at claimTaskSpace", () =>
    withMock(async ({ mock }) => {
      const task = await taskSpace("ended");
      mock.spaces.get(task.id)!.ownership = "user";
      await assert.rejects(
        () => task.page("p1").snapshot(),
        (error: any) => error.code === "ZEN_TASK_SPACE_INACTIVE" && /claimTaskSpace\(spaceId\)/.test(error.message),
      );
    }));
});

describe("unhandled pages", () => {
  it("a popup the script never used is reported after its output", () =>
    withMock(async ({ mock, round }) => {
      const task = await taskSpace("notice");
      await task.page("p1").click("a.late-popup");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { bufferOutput } = await import("../src/output.ts");
      bufferOutput("done\n");
      await round.reportUnhandledPages();
      assert.equal(captureFlush(), "done\n[zenius:pages]\nUnhandled page p2 from p1: https://example.com/late\n");
      assert.ok(mock.methods().includes("pages.list"));
    }));

  it("pages the script created or used are not reported", () =>
    withMock(async ({ round }) => {
      const task = await taskSpace("quiet");
      const popupWait = task.page("p1").waitForEvent("popup");
      await task.page("p1").click("a.popup");
      await popupWait;
      await task.newPage();
      await round.reportUnhandledPages();
      assert.equal(captureFlush(), "");
    }));
});

describe("the sandboxed CLI's output folder", () => {
  /**
   * Runs `body` as the sandboxed launcher runs the CLI: Node's permission
   * model on (stubbed here), the run's output folder in ZENIUS_OUTPUT_DIR,
   * and a temporary folder of its own as TMPDIR.
   */
  async function sandboxed(body: (folders: { out: string; box: string; work: string }) => Promise<void>): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), "zenius-sbx-"));
    const folders = { out: join(base, "out"), box: join(base, "box"), work: join(base, "work") };
    for (const folder of Object.values(folders)) mkdirSync(folder);
    const tmp = process.env.TMPDIR;
    Object.defineProperty(process, "permission", { value: { has: () => false }, configurable: true });
    process.env.ZENIUS_OUTPUT_DIR = folders.out;
    process.env.TMPDIR = folders.box;
    try {
      await body(folders);
    } finally {
      delete (process as { permission?: unknown }).permission;
      delete process.env.ZENIUS_OUTPUT_DIR;
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
      rmSync(base, { recursive: true, force: true });
    }
  }

  it("writes what a relative path names in the run's output folder, returns its absolute path, and lists it after the output", () =>
    withMock(() =>
      sandboxed(async ({ out, box }) => {
        const page = (await taskSpace("output")).page("p1");
        assert.equal(await page.screenshot({ path: "shots/a.png" }), join(out, "shots/a.png"));
        assert.ok(readFileSync(join(out, "shots/a.png")).equals(MOCK_PNG));
        const fetched = await page.fetch("/image.png", { saveAs: "image.png" });
        assert.equal(fetched.savedPath, join(out, "image.png"));
        const downloadPromise = page.waitForEvent("download", { timeout: 2000 });
        await page.click("button.download");
        const download: any = await downloadPromise;
        assert.equal(await download.saveAs("report.pdf"), join(out, "report.pdf"));
        assert.equal(readFileSync(join(out, "report.pdf"), "utf8"), "download d1");
        // The temporary folder takes absolute paths, and a screenshot without a path goes there.
        assert.equal(await page.screenshot({ path: join(box, "t.png") }), join(box, "t.png"));
        const unnamed = await page.screenshot();
        assert.ok(unnamed.startsWith(`${box}/zenius-shot-`), unnamed);
        // download.path()'s copy goes when the script ends, so it isn't listed.
        await download.path();
        const printed: string[] = [];
        flushOutput(false, (chunk) => printed.push(chunk));
        assert.equal(
          printed.join(""),
          ["[zenius:files]", ...[join(out, "shots/a.png"), join(out, "image.png"), join(out, "report.pdf"), join(box, "t.png"), unnamed].map((file) => `Wrote ${file}`), ""].join("\n"),
        );
      })));

  it("refuses to write anywhere else, the working folder above all, before asking the runtime", () =>
    withMock(({ mock }) =>
      sandboxed(async ({ out, work }) => {
        const page = (await taskSpace("refused")).page("p1");
        const downloadPromise = page.waitForEvent("download", { timeout: 2000 });
        await page.click("button.download");
        const download: any = await downloadPromise;
        const start = mock.requests.length;
        const refused = (label: string) =>
          new RegExp(`^${label}: a sandboxed script writes only to its output folder, ${out}, and its temporary folder, never its working folder\\. Pass a relative path, which lands in the output folder\\.$`);
        for (const [call, label] of [
          [() => page.screenshot({ path: join(work, "shot.png") }), "page.screenshot path"],
          [() => page.screenshot({ path: "../escape.png" }), "page.screenshot path"],
          [() => page.fetch("/x", { saveAs: join(work, ".git/hooks/pre-commit") }), "page.fetch saveAs"],
          [() => download.saveAs(join(work, ".venv/bin/git")), "download.saveAs"],
        ] as const) {
          await assert.rejects(call, (error: Error) => error instanceof ZeniusError && error.code === "ZEN_PATH_NOT_ALLOWED" && refused(label).test(error.message));
        }
        assert.equal(mock.requests.length, start, "no request reached the runtime");
        assert.deepEqual(readdirSync(work), []);
      })));
});
