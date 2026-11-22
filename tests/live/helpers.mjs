// Pure helpers for run.mjs, apart so the unit tests can import them (run.mjs reads its
// arguments when it loads).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

/** Ego Lite's MIT notice, as THIRD_PARTY.md quotes it under "- **Ego Lite**:". */
export function egoNotice(text = readFileSync(join(ROOT, "THIRD_PARTY.md"), "utf8")) {
  const lines = text.split("\n");
  const start = lines.indexOf("- **Ego Lite**:");
  const quote = [];
  for (const line of start >= 0 ? lines.slice(start + 1) : []) {
    if (/^ *>/.test(line)) quote.push(line.replace(/^ *> ?/, ""));
    else if (quote.length) break;
  }
  if (!quote[0]?.startsWith("MIT License") || !quote.some((l) => l.startsWith("Copyright"))) throw new Error("THIRD_PARTY.md quotes no MIT notice for Ego Lite");
  return quote.join("\n") + "\n";
}

/**
 * Each changeCount move during a run, next to the script that ran last before it: the
 * hook's nth allowed command is <task>.scripts/<n>.sh. A move can also be the user's own.
 */
export function pasteboardMoves(seen, allowedAt) {
  if (!seen.length) return null;
  const moves = seen.slice(1).map(({ at, count }) => {
    const n = allowedAt.filter((t) => t <= at).length;
    return { at: new Date(at).toISOString(), count, script: n ? `${String(n).padStart(3, "0")}.sh` : "before any command" };
  });
  return { first: seen[0].count, last: seen.at(-1).count, moves };
}
