// The MCP server's limits (mcp.ts), on their own so that the docs it serves
// (docs.ts) can state them without importing the server.

/** What read_page returns at most: a client shows about 25k tokens of a result. */
export const MAX_SNAPSHOT_CHARS = 60_000;
/** What evaluate returns at most. */
export const MAX_RESULT_CHARS = 20_000;
/**
 * A task's name at most, in characters: open's result shows it whole, which
 * is how the agent sidebar learns which task its chat started.
 */
export const TASK_NAME_MAX = 80;
/**
 * wait's limits, in seconds: a page condition, and the user's hand back.
 * Codex gives a tool call 60 s unless tool_timeout_sec says more, so neither
 * wait goes past 50 s unless the agent asks.
 */
export const WAIT_DEFAULT_S = 10;
export const WAIT_MAX_S = 50;
export const WAIT_USER_MAX_S = 600;
export const WAIT_USER_DEFAULT_S = 50;
/**
 * report_problem answers within 50 s of its start unless the agent asks for
 * a longer wait, as wait does: past Codex's 60 s the agent would get a
 * timeout instead of "still waiting". doctor's checks get 15 s at most (on
 * the daily instance, its probe of the sidebar's zenius mcp alone may take
 * 10 s), and the user what's left once the report is composed, at least
 * 10 s. The card stays up when the wait ends.
 */
export const REPORT_CALL_S = 50;
export const REPORT_DOCTOR_MS = 15_000;
export const REPORT_WAIT_MIN_S = 10;
/**
 * The script tool's limit, in seconds: 50 unless the agent asks, at most
 * 600. Every call also stays within the client's tool timeout less
 * CALL_MARGIN_S (TOOL_TIMEOUT_S below), so the server answers first.
 */
export const SCRIPT_DEFAULT_S = 50;
export const SCRIPT_MAX_S = 600;
/**
 * The client's tool timeout, which the agent sidebar passes as
 * ZENIUS_TOOL_TIMEOUT. Without it: Codex's default, 60 s, for Codex and any
 * client the server doesn't know; none for Claude Code, whose default is
 * about 27.8 hours. A call stays within it less CALL_MARGIN_S, and never
 * under CALL_MIN_S.
 */
export const TOOL_TIMEOUT_S = 60;
export const CALL_MARGIN_S = 10;
export const CALL_MIN_S = 5;
/** The only pages open and goto load: a file:, data: or browser URL would reach past the web. */
export const WEB_PROTOCOLS = ["http:", "https:"] as const;
