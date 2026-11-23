// The SDK's suite type-checks its own sources and tests. node --test strips
// the types and runs the code unchecked, so on 2026-11-23 a test that named
// PATH twice in one object (TS2783) passed every suite and reached main,
// until a tsc run for the next change refused it. tsc reads tsconfig.json,
// which covers src/ and test/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const SDK = fileURLToPath(new URL("../", import.meta.url));

it("tsc finds no type error in the SDK's sources and tests", () => {
  // The project's own TypeScript, run by this Node: no PATH or npx lookup.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", SDK], { cwd: SDK, encoding: "utf8" });
  assert.equal(result.status, 0, `tsc --noEmit -p sdk:\n${result.stdout}${result.stderr}`);
});
