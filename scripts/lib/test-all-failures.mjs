// The failed tests a suite's log names, for scripts/test-all.sh: it prints
// them above the log's tail, so a second failure in a suite never hides
// behind the one its last lines show, such as a known flake.
//
//   node scripts/lib/test-all-failures.mjs <log>
//
// Prints "N failed tests:" and a "  not ok <file>:<line> <name>" line for
// each, or nothing when the log names none (a runner that stopped before
// its tests, or one of its own whose tail says it all). It reads what the
// suites' runners write:
// - node --test's spec reporter, Node's default: each test in its "failing
//   tests" list, after a "test at <file>:<line>:<col>" line;
// - the tap reporter: each "not ok" with its YAML location, leaving out a
//   parent that failed only because a subtest did;
// - the dot reporter (the SDK's unit tests): each test in its "Failed tests"
//   list, by name only, since the reporter gives no file;
// - the ported e2e suite's runner: its "[FAIL] <case>" lines.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// A name this long is cut: the ux suite's run to 300 characters and more,
// and the log has the whole of it.
const NAME_MAX = 200;
const ANSI = /\x1b\[[0-9;]*m/g;
const SPEC_AT = /^test at (.+):(\d+):\d+$/;
// A test's line in the spec and dot lists: its name, then its time.
const MARKED = /^\u2716 (.+?)(?: \([\d.]+m?s\))?$/;
const TAP_NOT_OK = /^\s*not ok \d+ - (.*?)(?: # (TODO|SKIP)\b.*)?$/i;
const TAP_LOCATION = /^\s*location: '(.+):(\d+):\d+'$/;
const TAP_PARENT = /^\s*failureType: 'subtestsFailed'$/;
const DOT_PARENT = /^'\d+ subtests? failed'$/;
const E2E_FAIL = /^\[FAIL\] (.+?) \(\d+ ms\):/;

/**
 * The failed tests a suite's log names, in the order it names them, each
 * once.
 *
 * @param {string} text  the log
 * @param {string} [cwd]  a file under it reads relative to it, as the
 *   suites' runners name their files from the checkout's root
 * @returns {{file: string|null, line: number|null, name: string}[]}
 */
export function failedTests(text, cwd = process.cwd()) {
  const lines = String(text).replace(ANSI, "").split(/\r?\n/);
  const found = [];
  const seen = new Set();
  // tap names files by their real path, which on the Mac is under /private
  // where the folder given is not.
  const roots = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) {
      roots.push(real);
    }
  } catch {}
  const add = (file, line, name) => {
    const root = file && isAbsolute(file) ? roots.find(r => file.startsWith(r + sep)) : null;
    const shown = root ? relative(root, file) : file;
    const key = `${shown ?? ""}:${line ?? ""} ${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ file: shown, line, name });
    }
  };
  // The next line that isn't blank, from index i.
  const next = i => {
    while (i < lines.length && !lines[i].trim()) {
      i++;
    }
    return i;
  };
  let dotList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = SPEC_AT.exec(line))) {
      const j = next(i + 1);
      const name = MARKED.exec(lines[j] ?? "")?.[1] ?? "(its name isn't in the log)";
      add(m[1], Number(m[2]), name);
      continue;
    }
    if ((m = TAP_NOT_OK.exec(line))) {
      if (m[2]) {
        continue;
      }
      // Its YAML block, up to the next test.
      let file = null;
      let at = null;
      let parent = false;
      for (let j = i + 1; j < lines.length && !/^\s*(not )?ok \d+ /.test(lines[j]) && !/^\s*# Subtest:/.test(lines[j]); j++) {
        const loc = TAP_LOCATION.exec(lines[j]);
        if (loc) {
          [file, at] = [loc[1], Number(loc[2])];
        }
        parent ||= TAP_PARENT.test(lines[j]);
      }
      if (!parent) {
        add(file, at, m[1].replace(/\\([#\\])/g, "$1"));
      }
      continue;
    }
    if (line === "Failed tests:") {
      dotList = true;
      continue;
    }
    if (dotList && (m = MARKED.exec(line))) {
      // A parent that failed only because a subtest did says so next.
      const j = next(i + 1);
      if (!DOT_PARENT.test((lines[j] ?? "").trim())) {
        add(null, null, m[1]);
      }
      continue;
    }
    if ((m = E2E_FAIL.exec(line))) {
      add(null, null, m[1]);
    }
  }
  return found;
}

/**
 * What test-all prints of them, or "" for none.
 *
 * @param {{file: string|null, line: number|null, name: string}[]} tests
 */
export function failedTestsText(tests) {
  if (!tests.length) {
    return "";
  }
  const cut = name => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 3)}...` : name);
  const lines = tests.map(t => `  not ok ${t.file ? `${t.file}${t.line ? `:${t.line}` : ""} ` : ""}${cut(t.name)}`);
  return `${tests.length} failed test${tests.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n`;
}

/**
 * Whether node runs this file itself: by real paths, since node gives
 * import.meta.url the file's real path but leaves argv[1] as it was named,
 * and test-all.sh names it from a folder that may lie behind a link (on the
 * Mac, /tmp and $TMPDIR lie under /private).
 */
function runDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (process.argv[1] && runDirectly()) {
  const [log] = process.argv.slice(2);
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    // No log, no list: test-all prints the tail, or says the log is missing.
    process.exit(0);
  }
  process.stdout.write(failedTestsText(failedTests(text)));
}
