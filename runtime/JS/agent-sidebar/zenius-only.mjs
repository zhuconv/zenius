// Claude Code's PreToolUse hook for the agent sidebar's sessions. The
// workspace's .claude/settings.json and the session's flag-tier settings both
// name it (workspace.sys.mjs), as `node zenius-only.mjs work || exit 2`, or
// `node zenius-only.mjs chat <lists folder> || exit 2`. It runs under node,
// outside Zen. It stays in zenius's installed code, out of every agent's
// folder. zen-sidebar ported it from zen-eval's hook for the try Zen
// (2026-11-21).
//
// It can only refuse, never allow: a call it lets through still meets the
// session's permission rules, which allow these tools and nothing else.
//  - Both kinds may search the web and fetch pages (WebSearch, WebFetch: the
//    user's pass on defenses, 2026-11-21).
//  - In Chat, WebFetch opens only a URL that came from the session's search
//    results, the page it read or the user's own words: the session's list
//    (fetchable.sys.mjs). It's checked before anything else, so the host of
//    a URL that isn't listed is never looked up either: a DNS lookup of a
//    built name (<the chat's content>.example) would carry it out too.
//  - A Work session may also call zenius's browser tools (mcp__zenius__*), its
//    todo list, the tool search and AskUserQuestion. Past the hook, an ask
//    goes on to canUseTool and the sidebar's card (elicitation/create).
// Anything else, a kind it doesn't know, input it can't read, or an error
// here, is refused. The command's `|| exit 2` refuses when node itself can't
// run this file.
//
// WebFetch runs in the CLI, which Zen started, so macOS counts its requests
// as Zen.app's. A reach into the local network would raise macOS's Local
// Network prompt, whose answer covers the whole Zen.app, the user's own Zen
// included. So WebFetch stays off the local network as task pages do
// (zen-observe's observe/localnet.sys.mjs, which this follows): private and
// link-local addresses and .local names. Loopback stays open, as it does
// there. A Work session can open such a page in a tab, where the user's own
// list of local hosts (zenius.agentTabs.allowPrivateNetworks) applies.
// Unlike the tabs' rule, a name counts by what it resolves to as well (a
// router's name, 10-0-0-7.nip.io). The CLI looks the name up again when it
// connects, so a name whose answer changes in between (DNS rebinding) still
// gets through.
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { fetchKey, listName } from "./fetchable.sys.mjs";

const WORK = /^mcp__zenius__[A-Za-z0-9_]+$/;
// Every built-in Work offers its model (workspace.sys.mjs's CLAUDE_WORK_TOOLS):
// one it offers but this refuses fails as a step, as AskUserQuestion did.
const WORK_BUILTINS = new Set(["TodoWrite", "ToolSearch", "AskUserQuestion"]);
const WEB = new Set(["WebSearch", "WebFetch"]);

// localnet.sys.mjs's ranges. BlockList also checks an IPv4-mapped IPv6
// address (::ffff:192.168.1.1) against the IPv4 ones.
const LOCAL = new BlockList();
for (const [base, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16]]) {
  LOCAL.addSubnet(base, bits, "ipv4");
}
LOCAL.addSubnet("fc00::", 7, "ipv6");
LOCAL.addSubnet("fe80::", 10, "ipv6");
// How long a name's lookup may take, well inside the hook's 10 s.
const LOOKUP_MS = 3000;

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })
  );
  process.exit(0);
}

const isLocal = (address, family) => LOCAL.check(address, family === 6 ? "ipv6" : "ipv4");

/**
 * Whether a URL's host is on the local network: an address, read by the URL
 * parser the CLI uses (3232235777 and 0xC0A80101 are 192.168.1.1, as the
 * CLI would connect), a .local name, or a name any of whose addresses is
 * local. A name that doesn't exist isn't: nothing connects. Throws for a
 * URL it can't read ("url"), and for a lookup that fails or takes too long
 * ("lookup").
 */
async function onLocalNetwork(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    throw new Error("url");
  }
  if (host === "local" || host.endsWith(".local")) {
    return true;
  }
  const family = isIP(host);
  if (family !== 0) {
    return isLocal(host, family);
  }
  let timer;
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), LOOKUP_MS);
      }),
    ]);
    return addresses.some(({ address, family: f }) => isLocal(address, f));
  } catch (e) {
    if (e?.code === "ENOTFOUND" || e?.code === "ENODATA") {
      return false;
    }
    throw new Error("lookup");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why Chat may not fetch this URL, or null when it may: the URL must be on
 * the session's list, as fetchKey writes it. Without a list it can read, it
 * refuses.
 */
function notInSources(folder, input) {
  const key = fetchKey(input.tool_input?.url);
  if (!key) {
    return "WebFetch needs a full https:// URL.";
  }
  const name = listName(input.session_id);
  let list;
  try {
    if (!folder || !name) {
      throw new Error("no list");
    }
    list = readFileSync(join(folder, name), "utf8");
  } catch {
    return "WebFetch couldn't check this URL against the chat's sources, so it's refused. Answer from the page and your search results.";
  }
  if (list.split("\n").includes(key)) {
    return null;
  }
  return "In the sidebar's Chat, WebFetch opens only URLs that came from the page, the user's messages or your web search results, as they appear there. Search for the page, or ask the user for its address.";
}

let tool = "this tool";
try {
  const kind = process.argv[2];
  if (kind !== "work" && kind !== "chat") {
    throw new Error(`unknown session kind ${JSON.stringify(kind)}`);
  }
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (typeof input?.tool_name !== "string" || !input.tool_name) {
    throw new Error("no tool name in the hook's input");
  }
  tool = input.tool_name;
  if (WEB.has(tool)) {
    if (tool === "WebFetch") {
      if (kind === "chat") {
        const refusal = notInSources(process.argv[3], input);
        if (refusal) {
          deny(refusal);
        }
      }
      let local;
      try {
        local = await onLocalNetwork(input.tool_input?.url);
      } catch (e) {
        deny(
          e.message === "url"
            ? "WebFetch needs a full https:// URL."
            : "WebFetch couldn't check where this host points (its DNS lookup failed), so it's refused. Try again in a moment."
        );
      }
      if (local) {
        deny(
          kind === "work"
            ? "WebFetch doesn't reach the local network (private addresses, .local names, and names that point to either). Open the page with zenius's browser tools instead, where the user decides which local hosts agents may reach."
            : "WebFetch doesn't reach the local network (private addresses, .local names, and names that point to either) from the sidebar's Chat. Tell the user you can't read that page here."
        );
      }
    }
    process.exit(0);
  }
  if (kind === "work" && (WORK.test(tool) || WORK_BUILTINS.has(tool))) {
    process.exit(0);
  }
  if (kind === "work") {
    deny(`${tool} isn't available in the agent sidebar: only the zenius browser tools (mcp__zenius__*), web search and web fetch run here.`);
  }
  deny(`${tool} isn't available in the sidebar's Chat, whose only tools are web search and web fetch.`);
} catch (e) {
  process.stderr.write(`The zenius-only hook failed (${e?.message ?? e}), so ${tool} is refused.`);
  process.exit(2);
}
