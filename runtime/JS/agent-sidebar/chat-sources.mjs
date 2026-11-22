// Claude Code's PostToolUse hook for the sidebar's Chat sessions, on
// WebSearch and WebFetch. workspace.sys.mjs names it, in the workspace's
// .claude/settings.json and the session's flag-tier settings alike, as
// `node chat-sources.mjs <lists folder>`. It runs under node, outside Zen, in
// zenius's installed code, out of every agent's folder.
//
// It adds to the session's list of URLs Chat may fetch (fetchable.sys.mjs)
// the URLs that the CLI's own output gives:
//  - a web search's hits, not the search model's text or the query;
//  - the target of a redirect to another host, which the server chose, after
//    a fetch that zenius-only.mjs let through.
// It runs before the model sees the result, so a fetch of a hit finds it
// listed.
//
// It never stands in the way: it exits 0 whatever happens, and what it can't
// read stays off the list, so Chat can't fetch it.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listName, redirectTarget, searchHits } from "./fetchable.sys.mjs";

try {
  const folder = process.argv[2];
  const input = JSON.parse(readFileSync(0, "utf8"));
  const name = listName(input?.session_id);
  if (folder && name && input.hook_event_name === "PostToolUse") {
    const urls =
      input.tool_name === "WebSearch"
        ? [...searchHits(input.tool_response)]
        : input.tool_name === "WebFetch"
          ? [redirectTarget(input.tool_response)].filter(Boolean)
          : [];
    if (urls.length) {
      appendFileSync(join(folder, name), urls.map(url => `${url}\n`).join(""), { mode: 0o600 });
    }
  }
} catch (e) {
  process.stderr.write(`zenius's chat-sources hook noted nothing: ${e?.message ?? e}`);
}
process.exit(0);
