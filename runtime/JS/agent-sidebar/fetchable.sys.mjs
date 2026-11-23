/* Agent Sidebar: the URLs Chat may fetch. The user's call on defenses
 * (2026-11-21): Chat's WebFetch opens only a URL that came from its search
 * results, the page it read, or the user's own words. An injected line then
 * can't get Chat to build a URL that carries the chat's content to a server.
 * Work keeps any URL.
 *
 * Each Claude Code Chat session has a list, <profile>/agent-sidebar-allow/
 * <session id>.txt, one URL per line, as fetchKey writes it:
 *  - AgentService.allowFetches adds the URLs of each question before it goes
 *    out (the user's words, the page, its links, the selection, files);
 *  - chat-sources.mjs, Claude Code's PostToolUse hook, adds a web search's
 *    hits and the target of a redirect that a fetch reports;
 *  - zenius-only.mjs, the PreToolUse hook, refuses a Chat WebFetch of any
 *    other URL, and refuses every fetch when it can't read the list.
 *
 * AgentService imports this in Zen; the two hooks import it under node. So
 * it holds plain functions only, and no Gecko global.
 */

/** The lists' folder, in the profile. */
export const ALLOW_FOLDER = "agent-sidebar-allow";

// claude-agent-acp's session ids, which Claude Code's hooks get as
// session_id: randomUUID().
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The longest URL a list keeps: Claude Code's limit for a search hit's.
const MAX_URL = 8192;

/** A session's list's file name, or null for an id that isn't a UUID. */
export function listName(sessionId) {
  return typeof sessionId === "string" && SESSION.test(sessionId) ? `${sessionId}.txt` : null;
}

/**
 * A URL as the lists keep it, or null when it isn't an http(s) URL. The URL
 * parser's reading, as the CLI fetches it, with two changes that reach no
 * server: the fragment goes, and http becomes https, as the CLI upgrades it.
 * The rest stays as written, the path and query above all: they're where a
 * built URL would carry data, so a longer path or another query is another
 * URL.
 */
export function fetchKey(text) {
  if (typeof text !== "string" || !text || text.length > MAX_URL) {
    return null;
  }
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.hash = "";
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }
  return url.href;
}

// An http(s) URL written out in text. It stops at spaces, quotes, angle
// brackets and the characters URLs never hold raw.
const LINK = /\bhttps?:\/\/[^\s<>"'`\\^{}|[\]]+/gi;
// A bare address the user typed (example.com/docs, www.example.org): labels,
// a last label that starts with a letter, a port, a path. Not one inside a
// URL, a longer name or an email address.
const BARE =
  /(?<![\w@./:-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::\d{1,5})?(?:\/[^\s<>"'`\\^{}|[\]]*)?/gi;

/** A match without the punctuation that ends a sentence or a markdown link
 * around it: a closing bracket stays when the URL opened it. */
function trimmed(match) {
  let url = match;
  for (;;) {
    const last = url.at(-1);
    if (".,;:!?*_~".includes(last)) {
      url = url.slice(0, -1);
    } else if (last === ")" && url.split("(").length < url.split(")").length) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

/**
 * The URLs written out in a text, as fetchKey writes them. With `bare`, for
 * the user's own words, addresses without http(s):// too. A match counts as
 * written and without the punctuation around it, so Chat may fetch either.
 */
export function urlsIn(text, { bare = false } = {}) {
  const out = new Set();
  if (typeof text !== "string" || !text) {
    return out;
  }
  const add = candidate => {
    const key = fetchKey(candidate);
    if (key) {
      out.add(key);
    }
  };
  for (const [match] of text.matchAll(LINK)) {
    add(match);
    add(trimmed(match));
  }
  if (bare) {
    for (const [match] of text.matchAll(BARE)) {
      add(`https://${match}`);
      add(`https://${trimmed(match)}`);
    }
  }
  return out;
}

/**
 * A web search's hits, from Claude Code's WebSearch output (the hook's
 * tool_response): { query, results }, where a result is the search model's
 * text or { tool_use_id, content: [{ title, url }] }. Only the hits count.
 * The text and the query don't: the model wrote the query, and the text can
 * echo it.
 */
export function searchHits(response) {
  const out = new Set();
  for (const result of Array.isArray(response?.results) ? response.results : []) {
    if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
      continue;
    }
    for (const hit of result.content) {
      const key = fetchKey(hit?.url);
      if (key) {
        out.add(key);
      }
    }
  }
  return out;
}

/**
 * Where a fetch was sent instead, from Claude Code's WebFetch output: a
 * redirect to another host isn't followed, and the result names its target,
 * which the server chose, on the line after the URL Chat asked for. Only that
 * first "Redirect URL" line counts, and only when it holds the whole URL: the
 * model's prompt is echoed further down. Null for anything else.
 */
export function redirectTarget(response) {
  const text = typeof response?.result === "string" ? response.result : "";
  const code = response?.code;
  if (!text.startsWith("REDIRECT DETECTED") || !(code >= 300 && code < 400)) {
    return null;
  }
  const line = text.split("\n").find(l => l.startsWith("Redirect URL"));
  const match = /^Redirect URL \(from the server's Location header[^)]*\): (\S+)$/.exec(line ?? "");
  return match ? fetchKey(match[1]) : null;
}
