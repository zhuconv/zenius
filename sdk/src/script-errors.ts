// How an uncaught script error reads on stderr. Agents pay for every line, so
// keep the message, the code, and only the stack frames inside their script.

import { ZeniusError } from "./errors.ts";
import { formatValue } from "./output.ts";

const SCRIPT_FRAME = /\(?(?:file:\/\/)?[^\s()]*?(?:\bscript\.js|zenius-script-[0-9a-f-]+\.mjs):(\d+):(\d+)\)?/;

export function formatScriptError(error: unknown): string {
  if (!(error instanceof Error)) return `Uncaught ${formatValue(error)}`;
  if (error instanceof SyntaxError && error.message.startsWith("Script syntax error")) {
    return `SyntaxError: ${error.message}`;
  }
  const head =
    error instanceof ZeniusError
      ? `${error.name} [${error.code}]: ${error.message}`
      : `${error.name || "Error"}: ${error.message}`;
  const lines = [head];
  if (error instanceof ZeniusError && error.data && Object.keys(error.data).length > 0) {
    const data = formatValue(error.data);
    lines.push(`  data: ${data.length > 500 ? `${data.slice(0, 497)}...` : data}`);
  }
  lines.push(...scriptFrames(error.stack));
  return lines.join("\n");
}

/** Stack frames that point into the agent's script, renamed to script.js. */
export function scriptFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    if (!/^\s+at /.test(line)) continue;
    const match = SCRIPT_FRAME.exec(line);
    if (!match) continue;
    const fn = /^\s+at (?:async )?([^\s(]+) \(/.exec(line)?.[1];
    const where = `script.js:${match[1]}:${match[2]}`;
    frames.push(fn && fn !== "eval" ? `    at ${fn} (${where})` : `    at ${where}`);
  }
  return frames;
}
