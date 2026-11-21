// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Runs one agent script: an async function body with the SDK globals in
// scope, so top-level await and `return` work and line numbers in errors match
// the script. Static `import` statements switch to running it as an ES module.

import { fs, os, path, url, vm } from "./node.ts";
import { createRoundConsole, flushOutput, writeStderr } from "./output.ts";
import { formatScriptError } from "./script-errors.ts";

export const SCRIPT_FILENAME = "script.js";
const CONSOLE_KEY = Symbol.for("zenius.console");

export type ScriptGlobals = Record<string, unknown>;

export type RunResult = { exitCode: number; error?: unknown };

/**
 * Run `code` with `globals` in scope. Output stays buffered (see output.ts);
 * the caller flushes after any end-of-run reporting.
 */
export async function runScript(code: string, globals: ScriptGlobals): Promise<RunResult> {
  const console = createRoundConsole();
  // Helpers stay visible to modules the script imports; console stays lexical
  // so the CLI never replaces Node's own console.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
  }
  let fn: () => Promise<unknown>;
  try {
    fn = compileFunction(code, { ...globals, console });
  } catch (error) {
    if (error instanceof SyntaxError && /Cannot use import statement outside a module/.test(error.message)) {
      return runAsModule(code, console);
    }
    return { exitCode: 1, error: syntaxError(code, error) };
  }
  try {
    await fn();
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: 1, error: addPageContextHint(error) };
  }
}

function compileFunction(code: string, scope: ScriptGlobals): () => Promise<unknown> {
  const names = Object.keys(scope);
  // The header line ends where the script starts, so lineOffset -1 makes
  // reported lines the script's own.
  const source = `(async function (${names.join(", ")}) {"use strict";\n${code}\n})`;
  silenceVmLoaderWarning();
  const script = new vm.Script(source, {
    filename: SCRIPT_FILENAME,
    lineOffset: -1,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const outer = script.runInThisContext() as (...args: unknown[]) => Promise<unknown>;
  const values = names.map((name) => scope[name]);
  return () => outer(...values);
}

let vmWarningSilenced = false;

/**
 * Node marks the main-context loader for vm scripts experimental and warns on
 * stderr the first time it is used. The agent would read that warning as a
 * problem with its script, so drop exactly that one, for the whole run:
 * Node 23 warns at the script's first import(), long after it compiled
 * (Node 24 doesn't warn at all). Every other warning still prints.
 */
function silenceVmLoaderWarning(): void {
  if (vmWarningSilenced) return;
  vmWarningSilenced = true;
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (typeof text === "string" && text.includes("vm.USE_MAIN_CONTEXT_DEFAULT_LOADER")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
}

async function runAsModule(code: string, console: unknown): Promise<RunResult> {
  (globalThis as Record<symbol, unknown>)[CONSOLE_KEY] = console;
  // Prefixed on the first line so the module's line numbers stay the script's.
  const source = `const console = globalThis[Symbol.for("zenius.console")];${code}`;
  const suffix = Math.floor(Math.random() * 0xffffffff).toString(16);
  const file = path.join(os.tmpdir(), `zenius-script-${process.pid}-${suffix}.mjs`);
  try {
    fs.writeFileSync(file, source, { mode: 0o600 });
    await import(url.pathToFileURL(file).href);
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof SyntaxError) return { exitCode: 1, error: syntaxError(code, error) };
    return { exitCode: 1, error: addPageContextHint(error) };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** V8 reports compile errors without a location; recover it from the stack text. */
function syntaxError(code: string, original: unknown): SyntaxError {
  const message = original instanceof Error ? original.message : String(original);
  const stack = original instanceof Error ? (original.stack ?? "") : "";
  const lines = stack.split("\n");
  const at = /(?:^|\/)(?:script\.js|zenius-script-[^:]*\.mjs):(\d+)$/.exec(lines[0] ?? "");
  const userLines = code.split(/\r?\n/);
  if (at && lines.length >= 3) {
    const lineNumber = Number(at[1]);
    const caret = lines[2]!.indexOf("^");
    if (lineNumber >= 1 && lineNumber <= userLines.length) {
      const column = Math.max(caret, 0) + 1;
      const sourceLine = userLines[lineNumber - 1] ?? "";
      const error = new SyntaxError(
        `Script syntax error at line ${lineNumber}, column ${column}: ${message}\n` +
          `${lineNumber} | ${sourceLine}\n` +
          `${" ".repeat(String(lineNumber).length + 3 + Math.max(caret, 0))}^`,
      );
      error.cause = original;
      return error;
    }
    const error = new SyntaxError(
      `Script syntax error at the end of the script: ${message}. Check for an unclosed bracket, brace, string or template literal.`,
    );
    error.cause = original;
    return error;
  }
  return original instanceof SyntaxError ? original : new SyntaxError(message);
}

const PAGE_ONLY_GLOBALS = new Set([
  "document",
  "innerHeight",
  "innerWidth",
  "localStorage",
  "location",
  "scrollX",
  "scrollY",
  "sessionStorage",
  "window",
]);

/** Point the common Node-versus-Page mistake at page.evaluate(). */
export function addPageContextHint(error: unknown): unknown {
  if (!(error instanceof ReferenceError)) return error;
  const match = /^([A-Za-z_$][\w$]*) is not defined\.?$/.exec(error.message.trim());
  if (!match || !PAGE_ONLY_GLOBALS.has(match[1]!)) return error;
  const original = error.message;
  error.message =
    `${original}. The script runs in Node.js, not in the Page; ${match[1]} is a Page global. ` +
    "Put browser-side code inside page.evaluate(), for example page.evaluate(() => ...); keep Node.js work outside it.";
  if (typeof error.stack === "string") {
    const stackLines = error.stack.split("\n");
    stackLines[0] = `${error.name}: ${error.message}`;
    error.stack = stackLines.join("\n");
  }
  return error;
}

/** Finish a run: flush buffered output, then report an uncaught error on stderr. */
export function finishRun(result: RunResult): number {
  flushOutput(result.exitCode !== 0);
  if (result.error !== undefined) writeStderr(`${formatScriptError(result.error)}\n`);
  return result.exitCode;
}
