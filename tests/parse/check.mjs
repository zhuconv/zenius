// The parse check, test-all's "parse" lane: every script in runtime/JS
// parses the way Gecko loads it. A rebase can leave one that doesn't, with no
// conflict to show for it: panel.js's two `ago`s (2026-11-23) kept the whole
// panel from loading, and the panel's tests only timed out. Here it fails in
// a second, with its file and line. Nothing runs: vm only compiles.
//
// - Modules: the .mjs files, and any .js a page's <script type="module"> or a
//   module's import names (panel.js, the markdown parser).
// - Classic scripts, at script goal (vm.Script): every other .js (the .uc.js
//   files, the snapshot's sandbox scripts, the worker guard). node --check
//   would read them as CommonJS, which allows a top-level return.
//
// runtime/vendor (fx-autoconfig, unchanged and not ours) isn't checked.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dirname, "../..");
const JS = "runtime/JS";
// How an import names runtime/JS (fx-autoconfig's chrome package).
const CHROME = "chrome://userscripts/content/";

/**
 * Compiles a source as Gecko would load it, without running it.
 * @param {string} source
 * @param {"module" | "script"} goal
 * @param {string} file the name an error gives
 * @returns {{ imports: string[], error?: { line: number | null, message: string } }}
 */
function compile(source, goal, file) {
  try {
    if (goal === "script") {
      new vm.Script(source, { filename: file });
      return { imports: [] };
    }
    const module = new vm.SourceTextModule(source, { identifier: file });
    return { imports: module.moduleRequests?.map(request => request.specifier) ?? module.dependencySpecifiers };
  } catch (error) {
    return { imports: [], error: { line: lineOf(error, source, goal, file), message: `${error.name}: ${error.message}` } };
  }
}

/**
 * The line a syntax error is on. vm.Script's stack starts with it; a module's
 * doesn't, so node --check reads that one module again (only on a failure).
 */
function lineOf(error, source, goal, file) {
  if (goal === "script") {
    const head = String(error.stack).split("\n", 1)[0];
    return head.startsWith(`${file}:`) ? Number(head.slice(file.length + 1)) || null : null;
  }
  const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8" });
  return Number(/^\[stdin\]:(\d+)$/m.exec(check.stderr)?.[1]) || null;
}

/** The file in runtime/JS an import or a src names, or null (Gecko's own). */
function local(spec, from) {
  if (spec.startsWith(CHROME)) return join(JS, spec.slice(CHROME.length));
  return /^\.\.?\//.test(spec) ? join(dirname(from), spec) : null;
}

const t0 = performance.now();
if (!vm.SourceTextModule) {
  console.log("parse: vm.SourceTextModule needs node --experimental-vm-modules (tests/parse/run.sh)");
  process.exit(1);
}

// The check, on what it's for, before the runtime's: a module that both
// imports and declares a name (panel.js's two `ago`s), and a chrome script
// with a top-level return, each found on its line.
const CANARIES = [
  ["module", 'import { ago } from "./AgentService.sys.mjs";\n\nfunction ago() {}\n', 3],
  ["script", "(function () {})();\nreturn;\n", 2],
];
for (const [goal, source, line] of CANARIES) {
  const { error } = compile(source, goal, `canary.${goal}`);
  if (error?.line !== line) {
    console.log(`parse: the check misses its own case, ${JSON.stringify(source)} as a ${goal}, on line ${line}: ${JSON.stringify(error ?? "no error")}`);
    process.exit(1);
  }
}

const all = readdirSync(join(ROOT, JS), { recursive: true }).map(name => join(JS, name)).sort();
const read = file => readFileSync(join(ROOT, file), "utf8");
const goals = new Map(all.filter(file => /\.m?js$/.test(file)).map(file => [file, file.endsWith(".mjs") ? "module" : "script"]));
const modules = [...goals.keys()].filter(file => goals.get(file) === "module");
/** A .js loaded as a module is one: compile it with the modules. */
const asModule = file => {
  if (goals.get(file) !== "script") return;
  goals.set(file, "module");
  modules.push(file);
};
for (const page of all.filter(file => /\.x?html$/.test(file))) {
  for (const [, attrs] of read(page).matchAll(/<script\b([^>]*)>/g)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
    // A page's src is a URL: without a scheme, it's relative to the page.
    if (src && /\btype\s*=\s*["']module["']/.test(attrs)) asModule(/^[a-z][\w+.-]*:/i.test(src) ? local(src, page) : join(dirname(page), src));
  }
}

const errors = [];
// Modules first (the list grows): what they import is a module too.
for (let i = 0; i < modules.length; i++) {
  const { imports, error } = compile(read(modules[i]), "module", modules[i]);
  if (error) errors.push({ file: modules[i], ...error });
  for (const spec of imports) asModule(local(spec, modules[i]));
}
for (const [file, goal] of goals) {
  if (goal !== "script") continue;
  const { error } = compile(read(file), "script", file);
  if (error) errors.push({ file, ...error });
}

for (const { file, line, message } of errors) {
  console.log(`${file}${line ? `:${line}` : ""}: ${message} (as a ${goals.get(file) === "module" ? "module" : "classic script"})`);
}
const time = `${Math.round(performance.now() - t0)} ms`;
if (errors.length) {
  console.log(`parse: ${errors.length} of the ${goals.size} scripts in ${JS} ${errors.length === 1 ? "doesn't" : "don't"} parse as Gecko loads them (${time})`);
  process.exit(1);
}
console.log(`parse: all ${goals.size} scripts in ${JS} parse as Gecko loads them, ${modules.length} as modules and ${goals.size - modules.length} as classic scripts (${time})`);
