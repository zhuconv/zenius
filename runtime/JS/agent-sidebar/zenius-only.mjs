// Claude Code's PreToolUse hook for the agent sidebar's sessions. The
// workspace's .claude/settings.json and the session's flag-tier settings both
// name it (workspace.sys.mjs), as `node zenius-only.mjs <chat|work> || exit 2`.
// It runs under node, outside Zen. It stays in zenius's installed code, out of
// every agent's folder. zen-sidebar ported it from zen-eval's hook for the try
// Zen (2026-11-21).
//
// It can only refuse, never allow: a call it lets through still meets the
// session's permission rules, which allow zenius's tools and nothing else.
//  - A Work session may call zenius's browser tools (mcp__zenius__*), its todo
//    list and the tool search.
//  - A Chat session may call nothing.
// Anything else, a kind it doesn't know, input it can't read, or an error
// here, is refused. The command's `|| exit 2` refuses when node itself can't
// run this file.
import { readFileSync } from "node:fs";

const WORK = /^mcp__zenius__[A-Za-z0-9_]+$/;
const WORK_BUILTINS = new Set(["TodoWrite", "ToolSearch"]);

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })
  );
  process.exit(0);
}

let tool = "this tool";
try {
  const kind = process.argv[2];
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (typeof input?.tool_name !== "string" || !input.tool_name) {
    throw new Error("no tool name in the hook's input");
  }
  tool = input.tool_name;
  if (kind === "work" && (WORK.test(tool) || WORK_BUILTINS.has(tool))) {
    process.exit(0);
  }
  if (kind === "work") {
    deny(`${tool} isn't available in the agent sidebar: only the zenius browser tools (mcp__zenius__*) run here.`);
  }
  if (kind === "chat") {
    deny(`${tool} isn't available in the sidebar's Chat, which has no tools: answer in text.`);
  }
  throw new Error(`unknown session kind ${JSON.stringify(kind)}`);
} catch (e) {
  process.stderr.write(`The zenius-only hook failed (${e?.message ?? e}), so ${tool} is refused.`);
  process.exit(2);
}
