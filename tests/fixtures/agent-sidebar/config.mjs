// The agent sidebar's config for steady runs: the mock agent only (codex-like
// "mock", claude-like "mockclaude"), on the test's zenius instance, with the
// pages of serve.mjs on loopback and no other network. The mock's SCENARIO
// prompts drive this checkout's own `zenius mcp`, so their steps are the MCP
// server's real ones. Point the test profile's uc.agent-sidebar.config pref
// at the file it writes.
//   node tests/fixtures/agent-sidebar/config.mjs --instance <name> --out <config.json>
//        [--www http://127.0.0.1:47231] [--logs <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const here = dirname(new URL(import.meta.url).pathname);
const repo = resolve(here, "../../..");
const { values } = parseArgs({
  options: { instance: { type: "string" }, out: { type: "string" }, www: { type: "string" }, logs: { type: "string" } },
});
if (!values.instance || !values.out) {
  console.error("usage: config.mjs --instance <name> --out <config.json> [--www <url>] [--logs <dir>]");
  process.exit(2);
}
const out = resolve(values.out);
const logs = resolve(values.logs ?? join(dirname(out), "agent-sidebar-logs"));
const workspace = join(dirname(out), "agent-sidebar-workspace");
mkdirSync(logs, { recursive: true });
mkdirSync(workspace, { recursive: true });
const env = {
  // python3 through env(1), found on this PATH, on the Mac and on Linux.
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  MOCK_ZENIUS_MCP: `${process.execPath} ${join(repo, "sdk/bin/zenius")} mcp`,
  MOCK_WWW: values.www ?? "http://127.0.0.1:47231",
  ZENIUS_INSTANCE: values.instance,
};
const agent = (name, flag) => ({
  name,
  command: "/usr/bin/env",
  args: ["python3", join(here, "mock_agent.py"), join(logs, `${name.toLowerCase().replace(/\W+/g, "-")}.log`), ...flag],
  cwd: workspace,
  env,
});
const config = { default: "mock", agents: { mock: agent("Mock", []), mockclaude: agent("Mock Claude", ["--claude"]) } };
writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
console.log(out);
