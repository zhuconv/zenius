// The agent sidebar's Chat has one zenius tool, its docs: zenius's own text,
// which never touches the browser, so a user can ask Chat what an error
// means. Every other zenius tool stays out of Chat at each layer: Chat's
// zenius server serves the docs alone (zenius mcp --docs-only), Claude
// Code's options and settings allow no other, and the zenius-only hook
// refuses the rest. The docs answer while no Zen runs. The sidebar's agents
// and their zenius servers also take this Zen's zenius home and working
// folder, so a dev Zen's never reach the user's own.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { guardHome, scratchHome } from "../lib/scratch-home.mjs";
import { setup } from "./lib.mjs";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const CLI = join(REPO, "sdk/bin/zenius");
const HOOK = join(REPO, "runtime/JS/agent-sidebar/zenius-only.mjs");
const DEV = join(REPO, "scripts/zen-dev.sh");
// An instance that no Zen answers on.
const NO_ZEN = `nozen-chatdocs-${process.pid}`;

let h;
let lists;
// The CLI's HOME and, unless a server's entry names this Zen's, its
// ZENIUS_HOME: never the account's own (tests/lib/scratch-home.mjs).
let cliHome;
const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });

before(async () => {
  h = await setup();
  lists = mkdtempSync(join(tmpdir(), "zenius-chatdocs-"));
  cliHome = scratchHome("ux-docs");
});

after(async () => {
  rmSync(lists, { recursive: true, force: true });
  cliHome?.remove();
  await h?.close();
});

/**
 * What the sidebar gives a Chat session and a Work one, for Claude Code and
 * Codex, with this checkout's CLI; and zenius's folders as Zen has them and
 * as an agent's own environment does.
 */
function sessions() {
  return chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/workspace.sys.mjs");
     const { AgentService: A } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentService.sys.mjs");
     if (!A.base) throw new Error("the sidebar's service never started (agent-sidebar.uc.js)");
     const pref = "uc.agent-sidebar.zenius-cli";
     const had = Services.prefs.prefHasUserValue(pref) ? Services.prefs.getStringPref(pref) : null;
     Services.prefs.setStringPref(pref, arg.cli);
     try {
       const claude = { name: "Claude Code", command: "node", args: ["@agentclientprotocol/claude-agent-acp/dist/index.js"] };
       const chat = await W.sessionLimits(claude, "chat", A.base);
       const work = await W.sessionLimits(claude, "work", A.base);
       const codex = kind => W.codexEnvironment({}, kind, []).then(env => JSON.parse(env.CODEX_CONFIG).mcp_servers.zenius);
       const folders = env => ({ ZENIUS_HOME: env.ZENIUS_HOME, ZENIUS_WORKING_DIR: env.ZENIUS_WORKING_DIR });
       return {
         claude: chat.mcpServers,
         claudeWork: work.mcpServers,
         options: chat.meta.claudeCode.options,
         codex: await codex("chat"),
         codexWork: await codex("work"),
         zen: folders({ ZENIUS_HOME: Services.env.get("ZENIUS_HOME"), ZENIUS_WORKING_DIR: Services.env.get("ZENIUS_WORKING_DIR") }),
         agent: folders(W.agentEnvironment({})),
       };
     } finally {
       if (had === null) Services.prefs.clearUserPref(pref);
       else Services.prefs.setStringPref(pref, had);
     }`,
    { cli: CLI }
  );
}

/** A server's answers to `requests`, after initialize; then its stdin closes and it exits. */
async function mcp(command, args, env, requests) {
  const child = spawn(command, args, { env: cliHome.env(env), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", d => (out += d));
  child.stderr.setEncoding("utf8").on("data", d => (err += d));
  const messages = [
    { method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } },
    ...requests,
  ].map((r, id) => JSON.stringify({ jsonrpc: "2.0", id, ...r }));
  child.stdin.end(`${messages.join("\n")}\n`);
  const code = await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`${args.join(" ")} didn't finish in 20 s: ${err}`));
    }, 20000);
    child.on("exit", c => {
      clearTimeout(timer);
      done(c);
    });
  });
  const byId = new Map(
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .map(m => [m.id, m])
  );
  return { code, err, init: byId.get(0)?.result, answers: requests.map((_, i) => byId.get(i + 1)) };
}

/** The real hook's answer for Chat: "runs", or why it refused. */
function chatHook(tool, input = {}) {
  const r = spawnSync(process.execPath, [HOOK, "chat", lists], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, session_id: "4f3e2d1c-0b9a-4877-8665-5a4b3c2d1e0f" }),
    encoding: "utf8",
  });
  if (r.status !== 0) return `failed (${r.status})`;
  if (!r.stdout.trim()) return "runs";
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
}

/** Every tool zenius's whole server offers, which tools/list gives without Zen. */
async function zeniusTools() {
  const all = await mcp(CLI, ["mcp"], { ZENIUS_INSTANCE: NO_ZEN }, [{ method: "tools/list" }]);
  const names = all.answers[0].result.tools.map(t => t.name);
  assert.ok(names.includes("docs") && names.includes("open") && names.length > 10, names.join(", "));
  return names;
}

test("Chat's zenius server is zenius mcp --docs-only, for Claude Code and Codex alike, and Claude Code's Chat allows only its docs of zenius's tools", async () => {
  const s = await sessions();
  const env = ["ZENIUS_INSTANCE", "ZENIUS_HOME", "ZENIUS_WORKING_DIR"];
  assert.deepEqual(
    s.claude.map(server => [server.name, server.command, server.args, server.env.map(e => e.name)]),
    [["zenius", CLI, ["mcp", "--docs-only"], env]]
  );
  assert.deepEqual([s.codex.command, s.codex.args, Object.keys(s.codex.env)], [CLI, ["mcp", "--docs-only"], env]);
  assert.deepEqual(s.codexWork.args, ["mcp", "--sidebar"], "Work's server is the whole one, with the sidebar's grants under the launcher");
  const zenius = list => list.filter(tool => tool.startsWith("mcp__"));
  assert.deepEqual(zenius(s.options.allowedTools), ["mcp__zenius__docs"]);
  assert.deepEqual(zenius(s.options.settings.permissions.allow), ["mcp__zenius__docs"]);
  assert.equal(s.options.settings.permissions.defaultMode, "dontAsk", "a tool not allowed is refused, not asked about");
  assert.equal(s.options.strictMcpConfig, true);
  assert.deepEqual(s.options.mcpServers, {});
});

test("the sidebar's agents and their zenius servers, Chat's and Work's, take this Zen's zenius home and working folder, a scratch home's and the dev Zen's, so none reaches the user's own Zen, config.json or working folder", async () => {
  const s = await sessions();
  const want = {
    ZENIUS_HOME: process.env.ZENIUS_HOME,
    ZENIUS_WORKING_DIR: execFileSync(DEV, [process.env.ZENIUS_INSTANCE, "work"], { encoding: "utf8" }).trim(),
  };
  // tests/ux/run.sh gives the run a scratch zenius home, never the account's own.
  guardHome({ HOME: cliHome.home, ZENIUS_HOME: want.ZENIUS_HOME }, "chatdocs.test.mjs");
  assert.deepEqual(s.zen, want, "Zen has them (tests/ux/run.sh, scripts/zen-dev.sh)");
  assert.deepEqual(s.agent, want, "an agent's own environment");
  const folders = env => ({ ZENIUS_HOME: env.ZENIUS_HOME, ZENIUS_WORKING_DIR: env.ZENIUS_WORKING_DIR });
  const entry = server => folders(Object.fromEntries(server.env.map(e => [e.name, e.value])));
  assert.deepEqual(s.claudeWork.map(server => server.name), ["zenius"]);
  for (const [server, env] of [
    ["Claude Code's Chat", entry(s.claude[0])],
    ["Claude Code's Work", entry(s.claudeWork[0])],
    ["Codex's Chat", folders(s.codex.env)],
    ["Codex's Work", folders(s.codexWork.env)],
  ]) {
    assert.deepEqual(env, want, `${server} zenius server`);
  }
});

test("Chat's server, run as the sidebar runs it, answers with zenius's docs while no Zen runs, and has no other tool", async () => {
  const [server] = (await sessions()).claude;
  const others = (await zeniusTools()).filter(name => name !== "docs");
  const env = { ...Object.fromEntries(server.env.map(e => [e.name, e.value])), ZENIUS_INSTANCE: NO_ZEN };
  const chat = await mcp(server.command, server.args, env, [
    { method: "tools/list" },
    { method: "tools/call", params: { name: "docs", arguments: { topic: "ZEN_URL_NOT_ALLOWED" } } },
    { method: "resources/read", params: { uri: "zenius://docs/urls" } },
    ...others.map(name => ({ method: "tools/call", params: { name, arguments: { url: "https://example.com/" } } })),
  ]);
  assert.equal(chat.code, 0, chat.err);
  assert.match(chat.init.instructions, /zenius's docs only, and no browser tools/);
  const [list, docs, urls, ...refused] = chat.answers;
  assert.deepEqual(
    list.result.tools.map(t => t.name),
    ["docs"]
  );
  assert.equal(docs.result.isError, undefined, docs.result.content[0].text);
  assert.match(docs.result.content[0].text, /^Read zenius's docs: "ZEN_URL_NOT_ALLOWED"\nzenius \S+\n\n# ZEN_URL_NOT_ALLOWED\n\nAgents load only http:/);
  assert.match(urls.result.contents[0].text, /^# URLs$/m);
  refused.forEach((answer, i) => {
    assert.equal(answer.result.isError, true, others[i]);
    assert.equal(answer.result.content[0].text, `There is no tool named "${others[i]}".`);
  });
});

test("the zenius-only hook lets Chat read zenius's docs and refuses every other zenius tool there", async () => {
  assert.equal(chatHook("mcp__zenius__docs", { topic: "errors" }), "runs");
  for (const name of await zeniusTools()) {
    if (name === "docs") continue;
    assert.match(chatHook(`mcp__zenius__${name}`, { url: "https://example.com/" }), /isn't available in the sidebar's Chat/, name);
  }
  assert.match(chatHook("mcp__other__docs"), /isn't available in the sidebar's Chat/, "another server's tool of the same name");
});
