// test-all's report of a failed suite lists every test the suite's log
// names as failed, above the log's tail (scripts/lib/test-all-failures.mjs),
// so a second failure in a suite never hides behind the one the tail shows,
// such as a known flake's. The logs here are node --test's own, from each
// reporter the suites use: a Node that words them differently fails this
// test, not the next failed suite's report.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { failedTests, failedTestsText } from "../../scripts/lib/test-all-failures.mjs";
import { REPO_ROOT } from "../lib/targets.mjs";

// A passing test, a failing one, one in a describe, and a subtest.
const SAMPLE = `import assert from "node:assert/strict";
import { describe, test } from "node:test";

test("passes", () => {});

test("fails at top level", () => {
  assert.equal(1, 2);
});

describe("a group", () => {
  test("fails inside a describe", () => {
    throw new Error("boom");
  });
});

test("a parent", async t => {
  await t.test("fails as a subtest", () => {
    assert.ok(false, "nope");
  });
});
`;

const LEAVES = [
  ["sample.test.mjs", 6, "fails at top level"],
  ["sample.test.mjs", 11, "fails inside a describe"],
  ["sample.test.mjs", 17, "fails as a subtest"],
];

/** The environment a suite's runner gives node --test: not this file's, whose test context would make a child report to this run instead of printing. */
function runnerEnv(more = {}) {
  const env = { ...process.env, ...more };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** node --test's output, as a suite's log holds it. */
function nodeTest(cwd, args) {
  const r = spawnSync(process.execPath, ["--test", ...args], { cwd, env: runnerEnv(), encoding: "utf8", timeout: 60000 });
  return r.stdout + r.stderr;
}

test("each reporter's failed tests: spec (Node's default), tap and dot, with the file and line where the reporter gives them, and neither passing tests nor the parents of failed ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-ft-"));
  try {
    writeFileSync(join(dir, "sample.test.mjs"), SAMPLE);
    for (const reporter of [null, "spec", "tap"]) {
      const log = nodeTest(dir, [...(reporter ? [`--test-reporter=${reporter}`] : []), "sample.test.mjs"]);
      assert.deepEqual(
        failedTests(log, dir),
        LEAVES.map(([file, line, name]) => ({ file, line, name })),
        `${reporter ?? "the default"} reporter's log:\n${log}`
      );
    }
    // The dot reporter, the SDK's, names no file.
    const dot = nodeTest(dir, ["--test-reporter=dot", "sample.test.mjs"]);
    assert.deepEqual(
      failedTests(dot, dir),
      LEAVES.map(([, , name]) => ({ file: null, line: null, name })),
      `the dot reporter's log:\n${dot}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log of several runs names each failed test once, in order, with the e2e runner's [FAIL] cases by name; a log that names none gives nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-ft-"));
  try {
    writeFileSync(join(dir, "one.test.mjs"), `import { test } from "node:test";\ntest("first fails", () => { throw new Error("1"); });\n`);
    writeFileSync(join(dir, "two.test.mjs"), `import { test } from "node:test";\ntest("ok", () => {});\ntest("second fails", () => { throw new Error("2"); });\n`);
    const log = [
      nodeTest(dir, ["one.test.mjs"]),
      nodeTest(dir, ["two.test.mjs"]),
      "[FAIL] e2e-case (1234 ms): the page never loaded",
      // The same failure again, as a runner that runs a file twice prints it.
      nodeTest(dir, ["one.test.mjs"]),
    ].join("\n");
    assert.deepEqual(failedTests(log, dir), [
      { file: "one.test.mjs", line: 2, name: "first fails" },
      { file: "two.test.mjs", line: 3, name: "second fails" },
      { file: null, line: null, name: "e2e-case" },
    ]);
    // A runner that stopped before its tests: its tail says it all.
    assert.deepEqual(failedTests("starting the dev Zen\nno window after 90 s; stopping it\n"), []);
    assert.equal(failedTestsText([]), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the list's lines: not ok, the file and line when known, and the name, cut at 200 characters", () => {
  assert.equal(
    failedTestsText([
      { file: "tests/a.test.mjs", line: 7, name: "a" },
      { file: null, line: null, name: "x".repeat(250) },
    ]),
    `2 failed tests:\n  not ok tests/a.test.mjs:7 a\n  not ok ${"x".repeat(197)}...\n`
  );
  assert.equal(failedTestsText([{ file: "t.test.mjs", line: 1, name: "b" }]), "1 failed test:\n  not ok t.test.mjs:1 b\n");
});

test("test-all prints a failed suite's failed tests above its tail, so the one the tail leaves out shows too, from a checkout behind a link too", t => {
  // test-all as the checkout has it, in a checkout of its own with one
  // suite, which fails twice: first briefly, then with a message that fills
  // the log's last 20 lines.
  const tree = mkdtempSync(join(tmpdir(), "zt-fa-"));
  // test-all's TMPDIR, which on Linux must fit in 40 bytes: a short name.
  const tmp = mkdtempSync(join(tmpdir(), "f"));
  try {
    if (platform() === "linux" && Buffer.byteLength(tmp) > 40) {
      t.skip(`${tmp} is ${Buffer.byteLength(tmp)} bytes, longer than test-all's TMPDIR may be`);
      return;
    }
    mkdirSync(join(tree, "scripts", "lib"), { recursive: true });
    mkdirSync(join(tree, "tests", "lib"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "scripts", "test-all.sh"), join(tree, "scripts", "test-all.sh"));
    copyFileSync(join(REPO_ROOT, "scripts", "lib", "test-all-failures.mjs"), join(tree, "scripts", "lib", "test-all-failures.mjs"));
    // Each suite's zenius home (test-all's lane_home).
    for (const name of ["scratch-home.sh", "scratch-home.mjs"]) {
      copyFileSync(join(REPO_ROOT, "tests", "lib", name), join(tree, "tests", "lib", name));
    }
    const suite = join(tree, "tests", "zz");
    mkdirSync(suite, { recursive: true });
    writeFileSync(join(suite, "a.test.mjs"), `import { test } from "node:test";\ntest("a flake", () => { throw new Error("flaky"); });\n`);
    writeFileSync(
      join(suite, "b.test.mjs"),
      `import { test } from "node:test";\ntest("another failure", () => { throw new Error(Array.from({ length: 30 }, (_, i) => "line " + i).join("\\n")); });\n`
    );
    writeFileSync(join(suite, "run.sh"), `#!/usr/bin/env bash\ncd "$(dirname "\${BASH_SOURCE[0]}")/../.."\nexec node --test --test-concurrency=1 tests/zz/a.test.mjs tests/zz/b.test.mjs\n`);
    chmodSync(join(suite, "run.sh"), 0o755);

    // Through a link to the checkout, as the Mac's temporary folder lies
    // behind /var -> /private/var: test-all names the list's script by a
    // path through it.
    const via = `${tree}-link`;
    symlinkSync(tree, via);
    t.after(() => rmSync(via, { force: true }));
    const r = spawnSync("bash", [join(via, "scripts", "test-all.sh"), "zz"], {
      env: runnerEnv({ TMPDIR: tmp, ZENIUS_SERIAL: "1" }),
      encoding: "utf8",
      timeout: 120000,
    });
    const out = r.stdout;
    assert.equal(r.status, 1, `${out}\n${r.stderr}`);
    const lines = out.split("\n");
    const head = lines.findIndex(l => l.startsWith("FAIL zz, log "));
    assert.ok(head >= 0, out);
    assert.deepEqual(
      lines.slice(head + 1, head + 5),
      ["    2 failed tests:", "      not ok tests/zz/a.test.mjs:2 a flake", "      not ok tests/zz/b.test.mjs:2 another failure", "    The log ends:"],
      out
    );
    assert.doesNotMatch(lines.slice(head + 5, head + 25).join("\n"), /a flake/, `the tail alone leaves the first failure out:\n${out}`);
    assert.match(out, /^test-all: 1 failed: zz /m);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
