// Loaded before every integration test file (test-integration.sh's --import),
// and by node --test itself: the suite runs with a scratch HOME and
// ZENIUS_HOME (tests/lib/scratch-home.mjs), so no CLI or launcher it runs
// reaches the account's own ~/.zenius/config.json or ~/zenius-files. The
// scratch home's config names the dev Zen's working folder
// (ZENIUS_IT_WORKING_DIR, which zen-dev.sh started it with), so a file the
// runtime moved there is the one the CLI and the sandboxed launcher see. Its
// run/ and instances/ are links to the dev Zens' zenius home, where the
// instance's socket and registry record are.
//
// The first process to load this makes the home; the test files' processes
// inherit it (ZENIUS_IT_SCRATCH), and the first one removes it at its exit.

import { homedir } from "node:os";
import { join } from "node:path";

import { scratchHome } from "../../../tests/lib/scratch-home.mjs";

if (!process.env.ZENIUS_IT_SCRATCH) {
  const working = process.env.ZENIUS_IT_WORKING_DIR;
  if (!working) {
    throw new Error("ZENIUS_IT_WORKING_DIR must name the dev Zen's working folder (scripts/zen-dev.sh <instance> work): sdk/scripts/test-integration.sh sets it");
  }
  const runtimeHome = process.env.ZENIUS_HOME || join(homedir(), ".zenius");
  const scratch = scratchHome("it", { workingFolder: working });
  scratch.shareRuntime(runtimeHome);
  process.env.ZENIUS_IT_SCRATCH = scratch.root;
  process.env.HOME = scratch.home;
  process.env.ZENIUS_HOME = scratch.zeniusHome;
  process.on("exit", () => scratch.remove());
}
