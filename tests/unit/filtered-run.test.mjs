// A suite runner's run that filters tests by name ends even in a file where
// the filter selects none of the tests (tests/lib/node-test.sh). Node starts
// such a file's before hooks but runs its after hooks without waiting for
// them, so what a before opens late, such as setup()'s connection to Zen,
// outlives every after hook and held the file open for good.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../lib/targets.mjs";

const HELPER = join(REPO_ROOT, "tests/lib/node-test.sh");
const FIXTURE = join(REPO_ROOT, "tests/unit/fixtures/filtered-before.mjs");
const NONE = "--test-name-pattern=zz-selects-nothing";

/** The flags the runners' helper gives `node --test` for these arguments. */
function flags(...args) {
  const r = spawnSync("bash", ["-c", '. "$1"; shift; node_test_flags "$@"', "bash", HELPER, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}

/** The fixture run as a runner runs a file, with a filter that selects none of its tests. */
function filtered(extra) {
  // Without it the run is this file's own nested one, which runs no files.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--test", ...extra, NONE, FIXTURE], { encoding: "utf8", env, timeout: 60000 });
  return { ...r, out: r.stdout + r.stderr, ms: Date.now() - started };
}

test("a run that filters tests gets --test-force-exit, and a full run nothing", () => {
  assert.deepEqual(flags(), []);
  assert.deepEqual(flags("tests/core/pages.test.mjs"), []);
  for (const filter of ["--test-name-pattern=x", "--test-name-pattern", "--test-skip-pattern=x", "--test-only"]) {
    assert.deepEqual(flags("tests/core/pages.test.mjs", filter), ["--test-force-exit"], filter);
  }
});

test("a filter that selects none of a file's tests: with the helper's flags the file ends at its after hooks, before its before finishes", () => {
  // The premise, Node's order: the after hooks ran first, and what the
  // before opened then kept the file running until it closed by itself.
  const plain = filtered([]);
  assert.equal(plain.status, 0, plain.out);
  assert.match(plain.out, /zz: the after hooks ran, before the before finished[^]*zz: the before finished/, plain.out);
  assert.ok(plain.ms >= 2500, `the file ended after ${plain.ms} ms, before the before's hold did`);

  const fixed = filtered(flags(NONE));
  assert.equal(fixed.status, 0, fixed.out);
  assert.match(fixed.out, /zz: the after hooks ran/, fixed.out);
  assert.doesNotMatch(fixed.out, /zz: the before finished/, "the file was still running when its before finished");
});
