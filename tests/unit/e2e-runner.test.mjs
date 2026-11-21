// The e2e runner must not pass a case whose script never ran or never
// reached its end. Uses a fake ego-browser, so no browser is needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../lib/targets.mjs";

function runWith(mode) {
  const dir = mkdtempSync(join(tmpdir(), "zen-eval-runner-test-"));
  const results = join(dir, "results.json");
  try {
    spawnSync(process.execPath, [join(REPO_ROOT, "tests/e2e/runner.mjs"), "--target", "ego", "--only", "Page text locators", "--results", results], {
      env: {
        ...process.env,
        // The fake CLI starts through its #!/usr/bin/env node line.
        PATH: dirname(process.execPath) + delimiter + process.env.PATH,
        EGO_BROWSER_CLI: join(REPO_ROOT, "tests/unit/fixtures/fake-cli.mjs"),
        FAKE_MODE: mode,
      },
      encoding: "utf8",
    });
    return JSON.parse(readFileSync(results, "utf8")).cases.find((c) => c.name === "Page text locators");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a launcher that exits 0 without running the script fails the case", () => {
  assert.equal(runWith("silent").status, "fail");
});

test("a success summary without the run's sentinel fails the case", () => {
  const result = runWith("nonceless");
  assert.equal(result.status, "fail");
  assert.match(result.message, /sentinel/);
});

test("a summary carrying the sentinel passes", () => {
  assert.equal(runWith("honest").status, "pass");
});
